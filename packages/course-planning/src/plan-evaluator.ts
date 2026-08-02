import { createHash } from "node:crypto";

import { ApprovedCourseCatalogSnapshotSchema } from "./contracts.js";
import type { ApprovedCourseCatalogSnapshot } from "./contracts.js";
import type { z } from "zod";
import { CourseCatalogConflictError } from "./errors.js";
import { evaluateCourseSelection } from "./evaluator.js";
import {
  FrozenPlanCatalogSchema,
  ManualPlanContentSchema,
  ManualPlanStudentInputSchema,
  PlanEvaluationSnapshotSchema,
} from "./plan-contracts.js";
import type {
  FrozenPlanCatalog,
  ManualPlanContent,
  ManualPlanStudentInput,
  PlanEvaluationSnapshot,
  PlanViolation,
} from "./plan-contracts.js";

export function stablePlanJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stablePlanJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stablePlanJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPlanValue(value: unknown): string {
  return createHash("sha256").update(stablePlanJson(value), "utf8").digest("hex");
}

export function collectPlanCourseVersionIds(
  content: ManualPlanContent,
  studentInput: ManualPlanStudentInput,
): string[] {
  const parsedContent = ManualPlanContentSchema.parse(content);
  const parsedInput = ManualPlanStudentInputSchema.parse(studentInput);
  return [
    ...new Set([
      ...parsedInput.inProgressCourseVersionIds,
      ...parsedContent.shortTermItems.map((item) => item.courseVersionId),
      ...parsedContent.routes.flatMap((route) =>
        route.phases.flatMap((phase) => phase.courseVersionIds),
      ),
    ]),
  ].sort();
}

export function selectRelevantPlanCatalog(
  fullCatalog: ApprovedCourseCatalogSnapshot,
  content: ManualPlanContent,
  studentInput: ManualPlanStudentInput,
): FrozenPlanCatalog {
  const catalog = ApprovedCourseCatalogSnapshotSchema.parse(fullCatalog);
  const usedVersionIds = collectPlanCourseVersionIds(content, studentInput);
  const coursesByVersion = new Map(
    catalog.courses.map((course) => [course.courseVersionId, course]),
  );
  const usedCourses = usedVersionIds.map((versionId) => {
    const course = coursesByVersion.get(versionId);
    if (course === undefined) {
      throw new CourseCatalogConflictError(
        "Every planned course version must currently be approved.",
      );
    }
    return course;
  });
  const inProgressIds = new Set(studentInput.inProgressCourseVersionIds);
  const plannedIds = new Set(
    content.shortTermItems
      .map((item) => item.courseVersionId)
      .concat(
        content.routes.flatMap((route) => route.phases.flatMap((phase) => phase.courseVersionIds)),
      ),
  );
  if ([...inProgressIds].some((versionId) => plannedIds.has(versionId))) {
    throw new CourseCatalogConflictError("An in-progress course cannot be planned again.");
  }
  const usedCourseIds = new Set(usedCourses.map((course) => course.courseId));
  if ([...usedCourseIds].some((courseId) => studentInput.completedCourseIds.includes(courseId))) {
    throw new CourseCatalogConflictError("A completed course cannot be planned again.");
  }

  const plannedPeriods = [
    ...content.shortTermItems.map((item) => ({
      courseVersionIds: [item.courseVersionId],
      period: item.period,
    })),
    ...content.routes.flatMap((route) =>
      route.phases.map((phase) => ({
        courseVersionIds: phase.courseVersionIds,
        period: phase.period,
      })),
    ),
  ];
  for (const plannedPeriod of plannedPeriods) {
    for (const courseVersionId of plannedPeriod.courseVersionIds) {
      const course = coursesByVersion.get(courseVersionId);
      if (
        course?.content.deliveryMode === "scheduled" &&
        course.content.termStartDate !== undefined &&
        course.content.termEndDate !== undefined &&
        (plannedPeriod.period.startDate > course.content.termStartDate ||
          plannedPeriod.period.endDate < course.content.termEndDate)
      ) {
        throw new CourseCatalogConflictError(
          "A scheduled plan item must contain the approved course offering dates.",
        );
      }
    }
  }

  const rules = catalog.rules.filter((rule) => {
    if (rule.ruleType === "time_conflict" || rule.ruleType === "load_limit") return true;
    if (rule.ruleType === "age_range" || rule.ruleType === "prerequisite") {
      return usedCourseIds.has(rule.subjectCourseId);
    }
    return usedCourseIds.has(rule.courseAId) || usedCourseIds.has(rule.courseBId);
  });
  const referencedCourseIds = new Set(usedCourseIds);
  for (const rule of rules) {
    if (rule.ruleType === "age_range") referencedCourseIds.add(rule.subjectCourseId);
    if (rule.ruleType === "prerequisite") {
      referencedCourseIds.add(rule.subjectCourseId);
      referencedCourseIds.add(rule.requiredCourseId);
    }
    if (rule.ruleType === "mutual_exclusion") {
      referencedCourseIds.add(rule.courseAId);
      referencedCourseIds.add(rule.courseBId);
    }
  }
  const courses = catalog.courses.filter((course) => referencedCourseIds.has(course.courseId));
  if (new Set(courses.map((course) => course.courseId)).size !== referencedCourseIds.size) {
    throw new CourseCatalogConflictError(
      "A plan rule references a course without an approved version.",
    );
  }
  return FrozenPlanCatalogSchema.parse({ courses, rules });
}

function withViolationKeys(
  scopeKey: string,
  violations: ReturnType<typeof evaluateCourseSelection>["violations"],
): PlanViolation[] {
  return violations.map((violation) => ({
    ...violation,
    violationKey: hashPlanValue({
      courseIds: [...violation.courseIds].sort(),
      ruleType: violation.ruleType,
      ruleVersionId: violation.ruleVersionId,
      scopeKey,
    }),
  }));
}

export function evaluateManualPlan(
  frozenCatalog: FrozenPlanCatalog,
  content: ManualPlanContent,
  studentInput: ManualPlanStudentInput,
  evaluatedAt: Date,
): PlanEvaluationSnapshot {
  const catalog = FrozenPlanCatalogSchema.parse(frozenCatalog);
  const parsedContent = ManualPlanContentSchema.parse(content);
  const parsedInput = ManualPlanStudentInputSchema.parse(studentInput);
  const coursesByVersion = new Map(
    catalog.courses.map((course) => [course.courseVersionId, course]),
  );
  const inProgressCourseIds = parsedInput.inProgressCourseVersionIds.map((versionId) => {
    const course = coursesByVersion.get(versionId);
    if (course === undefined) throw new CourseCatalogConflictError();
    return course.courseId;
  });
  const scopes: Array<z.infer<typeof PlanEvaluationSnapshotSchema>["scopes"][number]> = [];

  const evaluateScope = (
    scopeKey: string,
    label: string,
    selectedCourseVersionIds: string[],
    completedCourseIds: string[],
  ): void => {
    const result = evaluateCourseSelection(catalog, {
      ageYears: parsedInput.ageYears,
      completedCourseIds,
      selectedCourseVersionIds,
    });
    scopes.push({
      completedCourseIds,
      label,
      result: { ...result, violations: withViolationKeys(scopeKey, result.violations) },
      scopeKey,
    });
  };

  evaluateScope(
    "short_term",
    "近期安排",
    [
      ...parsedInput.inProgressCourseVersionIds,
      ...parsedContent.shortTermItems.map((item) => item.courseVersionId),
    ],
    parsedInput.completedCourseIds,
  );

  for (const route of parsedContent.routes) {
    const completed = new Set(parsedInput.completedCourseIds);
    for (const [index, phase] of route.phases.entries()) {
      const selectedCourseVersionIds =
        index === 0
          ? [...parsedInput.inProgressCourseVersionIds, ...phase.courseVersionIds]
          : phase.courseVersionIds;
      evaluateScope(
        `${route.key}_phase_${String(phase.sequence)}`,
        `${route.name} · ${phase.label}`,
        selectedCourseVersionIds,
        [...completed].sort(),
      );
      if (index === 0) {
        for (const courseId of inProgressCourseIds) completed.add(courseId);
      }
      for (const versionId of phase.courseVersionIds) {
        const course = coursesByVersion.get(versionId);
        if (course === undefined) throw new CourseCatalogConflictError();
        completed.add(course.courseId);
      }
    }
  }

  const violations = scopes.flatMap((scope) => scope.result.violations);
  return PlanEvaluationSnapshotSchema.parse({
    evaluatedAt: evaluatedAt.toISOString(),
    hardViolationCount: violations.filter((violation) => violation.severity === "hard").length,
    scopes,
    warningCount: violations.filter((violation) => violation.severity === "warning").length,
  });
}
