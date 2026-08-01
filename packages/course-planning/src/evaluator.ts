import {
  ApprovedCourseCatalogSnapshotSchema,
  CourseSelectionInputSchema,
  CourseSelectionResultSchema,
  type ApprovedCourse,
  type ApprovedCourseCatalogSnapshot,
  type ApprovedCourseRule,
  type CourseRuleViolation,
  type CourseSelectionInput,
  type CourseSelectionResult,
  type WeeklySession,
} from "./contracts.js";
import { CourseCatalogConflictError, CourseRuleConfigurationError } from "./errors.js";

function orderedPair(first: string, second: string): string {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function semanticRuleKey(rule: ApprovedCourseRule): string {
  if (rule.ruleType === "prerequisite") {
    return `${rule.ruleType}:${rule.subjectCourseId}:${rule.requiredCourseId}`;
  }
  if (rule.ruleType === "mutual_exclusion") {
    return `${rule.ruleType}:${orderedPair(rule.courseAId, rule.courseBId)}`;
  }
  if (rule.ruleType === "age_range") {
    return `${rule.ruleType}:${rule.subjectCourseId}:${String(rule.minAge ?? "")}:${String(rule.maxAge ?? "")}`;
  }
  if (rule.ruleType === "time_conflict") return rule.ruleType;
  return `${rule.ruleType}:${String(rule.maxWeeklyMinutes ?? "")}:${String(rule.maxConcurrentCourses ?? "")}`;
}

function findPrerequisiteCycles(rules: readonly ApprovedCourseRule[]): string[] {
  const adjacency = new Map<string, Set<string>>();
  for (const rule of rules) {
    if (rule.ruleType !== "prerequisite") continue;
    const neighbors = adjacency.get(rule.subjectCourseId) ?? new Set<string>();
    neighbors.add(rule.requiredCourseId);
    adjacency.set(rule.subjectCourseId, neighbors);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleRoots = new Set<string>();

  function visit(courseId: string): void {
    if (visiting.has(courseId)) {
      cycleRoots.add(courseId);
      return;
    }
    if (visited.has(courseId)) return;
    visiting.add(courseId);
    for (const required of adjacency.get(courseId) ?? []) visit(required);
    visiting.delete(courseId);
    visited.add(courseId);
  }

  for (const courseId of adjacency.keys()) visit(courseId);
  return [...cycleRoots].sort();
}

export function validateCourseRuleSet(snapshot: ApprovedCourseCatalogSnapshot): string[] {
  const parsed = ApprovedCourseCatalogSnapshotSchema.parse(snapshot);
  const issues: string[] = [];
  const semanticKeys = new Set<string>();
  const prerequisitePairs = new Set<string>();
  const mutualExclusionPairs = new Set<string>();
  const ageBounds = new Map<string, { maximum: number; minimum: number }>();

  for (const rule of parsed.rules) {
    const key = semanticRuleKey(rule);
    if (semanticKeys.has(key)) issues.push(`duplicate_rule:${key}`);
    semanticKeys.add(key);
    if (rule.ruleType === "prerequisite") {
      prerequisitePairs.add(orderedPair(rule.subjectCourseId, rule.requiredCourseId));
    } else if (rule.ruleType === "mutual_exclusion") {
      mutualExclusionPairs.add(orderedPair(rule.courseAId, rule.courseBId));
    } else if (rule.ruleType === "age_range") {
      const current = ageBounds.get(rule.subjectCourseId) ?? { maximum: 100, minimum: 3 };
      current.minimum = Math.max(current.minimum, rule.minAge ?? 3);
      current.maximum = Math.min(current.maximum, rule.maxAge ?? 100);
      ageBounds.set(rule.subjectCourseId, current);
    }
  }
  for (const pair of prerequisitePairs) {
    if (mutualExclusionPairs.has(pair)) issues.push(`prerequisite_mutex_conflict:${pair}`);
  }
  for (const [courseId, bounds] of ageBounds) {
    if (bounds.maximum < bounds.minimum) issues.push(`age_range_conflict:${courseId}`);
  }
  for (const courseId of findPrerequisiteCycles(parsed.rules)) {
    issues.push(`prerequisite_cycle:${courseId}`);
  }
  return [...new Set(issues)].sort();
}

function termsOverlap(first: ApprovedCourse, second: ApprovedCourse): boolean {
  const firstStart = first.content.termStartDate;
  const firstEnd = first.content.termEndDate;
  const secondStart = second.content.termStartDate;
  const secondEnd = second.content.termEndDate;
  if (
    firstStart === undefined ||
    firstEnd === undefined ||
    secondStart === undefined ||
    secondEnd === undefined
  ) {
    return false;
  }
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function weeklySessionsOverlap(first: WeeklySession, second: WeeklySession): boolean {
  return (
    first.weekday === second.weekday &&
    first.startMinute < second.endMinute &&
    second.startMinute < first.endMinute
  );
}

function courseSchedulesOverlap(first: ApprovedCourse, second: ApprovedCourse): boolean {
  if (!termsOverlap(first, second)) return false;
  return first.content.schedule.some((firstSession) =>
    second.content.schedule.some((secondSession) =>
      weeklySessionsOverlap(firstSession, secondSession),
    ),
  );
}

function addViolation(
  violations: CourseRuleViolation[],
  rule: ApprovedCourseRule,
  courseIds: string[],
): void {
  violations.push({
    courseIds,
    message: rule.message,
    ruleType: rule.ruleType,
    ruleVersionId: rule.ruleVersionId,
    severity: rule.severity,
  });
}

export function evaluateCourseSelection(
  snapshot: ApprovedCourseCatalogSnapshot,
  input: CourseSelectionInput,
): CourseSelectionResult {
  const parsedSnapshot = ApprovedCourseCatalogSnapshotSchema.parse(snapshot);
  const parsedInput = CourseSelectionInputSchema.parse(input);
  const configurationIssues = validateCourseRuleSet(parsedSnapshot);
  if (configurationIssues.length > 0) throw new CourseRuleConfigurationError(configurationIssues);

  const coursesByVersion = new Map(
    parsedSnapshot.courses.map((course) => [course.courseVersionId, course]),
  );
  const selected = parsedInput.selectedCourseVersionIds.map((courseVersionId) => {
    const course = coursesByVersion.get(courseVersionId);
    if (course === undefined) {
      throw new CourseCatalogConflictError("A selected course version is not currently approved.");
    }
    return course;
  });
  if (new Set(selected.map((course) => course.courseId)).size !== selected.length) {
    throw new CourseCatalogConflictError("Only one approved version of a course may be selected.");
  }

  const selectedCourseIds = new Set(selected.map((course) => course.courseId));
  const completedCourseIds = new Set(parsedInput.completedCourseIds);
  if (selected.some((course) => completedCourseIds.has(course.courseId))) {
    throw new CourseCatalogConflictError("A completed course cannot be selected again.");
  }
  const violations: CourseRuleViolation[] = [];
  const totalWeeklyLoadMinutes = selected.reduce(
    (total, course) => total + course.content.weeklyLoadMinutes,
    0,
  );

  for (const rule of parsedSnapshot.rules) {
    if (rule.ruleType === "prerequisite") {
      if (
        selectedCourseIds.has(rule.subjectCourseId) &&
        !completedCourseIds.has(rule.requiredCourseId)
      ) {
        addViolation(violations, rule, [rule.subjectCourseId, rule.requiredCourseId]);
      }
    } else if (rule.ruleType === "mutual_exclusion") {
      if (selectedCourseIds.has(rule.courseAId) && selectedCourseIds.has(rule.courseBId)) {
        addViolation(violations, rule, [rule.courseAId, rule.courseBId]);
      }
    } else if (rule.ruleType === "age_range") {
      if (
        selectedCourseIds.has(rule.subjectCourseId) &&
        ((rule.minAge !== undefined && parsedInput.ageYears < rule.minAge) ||
          (rule.maxAge !== undefined && parsedInput.ageYears > rule.maxAge))
      ) {
        addViolation(violations, rule, [rule.subjectCourseId]);
      }
    } else if (rule.ruleType === "time_conflict") {
      for (let first = 0; first < selected.length; first += 1) {
        const firstCourse = selected[first];
        if (firstCourse === undefined) continue;
        for (let second = first + 1; second < selected.length; second += 1) {
          const secondCourse = selected[second];
          if (secondCourse !== undefined && courseSchedulesOverlap(firstCourse, secondCourse)) {
            addViolation(violations, rule, [firstCourse.courseId, secondCourse.courseId]);
          }
        }
      }
    } else if (
      (rule.maxWeeklyMinutes !== undefined && totalWeeklyLoadMinutes > rule.maxWeeklyMinutes) ||
      (rule.maxConcurrentCourses !== undefined && selected.length > rule.maxConcurrentCourses)
    ) {
      addViolation(
        violations,
        rule,
        selected.slice(0, 2).map((course) => course.courseId),
      );
    }
  }

  return CourseSelectionResultSchema.parse({
    eligible: violations.every((violation) => violation.severity !== "hard"),
    selectedCourseVersionIds: parsedInput.selectedCourseVersionIds,
    totalWeeklyLoadMinutes,
    violations,
  });
}
