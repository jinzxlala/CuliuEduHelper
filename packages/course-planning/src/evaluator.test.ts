import { describe, expect, it } from "vitest";

import {
  ApprovedCourseCatalogSnapshotSchema,
  CourseVersionContentSchema,
  type ApprovedCourse,
  type ApprovedCourseCatalogSnapshot,
  type ApprovedCourseRule,
  type CourseRuleDefinition,
} from "./contracts.js";
import { evaluateCourseSelection, validateCourseRuleSet } from "./evaluator.js";
import { CourseCatalogConflictError, CourseRuleConfigurationError } from "./errors.js";

const courseAId = "10000000-0000-4000-8000-000000000001";
const courseBId = "10000000-0000-4000-8000-000000000002";
const courseCId = "10000000-0000-4000-8000-000000000003";
const versionAId = "20000000-0000-4000-8000-000000000001";
const versionBId = "20000000-0000-4000-8000-000000000002";
const versionCId = "20000000-0000-4000-8000-000000000003";

function course(
  courseId: string,
  courseVersionId: string,
  code: string,
  options: {
    endMinute?: number;
    startsOn?: string;
    startMinute?: number;
    weeklyLoadMinutes?: number;
    weekday?: number;
  } = {},
): ApprovedCourse {
  return {
    code,
    content: {
      capabilityTags: ["synthetic.capability"],
      deliverables: ["Synthetic deliverable"],
      deliveryMode: "scheduled",
      difficulty: "foundation",
      durationWeeks: 8,
      notSuitableConditions: [],
      objectives: ["Synthetic objective"],
      projectTypes: ["synthetic.project"],
      schedule: [
        {
          endMinute: options.endMinute ?? 660,
          startMinute: options.startMinute ?? 600,
          weekday: options.weekday ?? 1,
        },
      ],
      stage: "Synthetic stage",
      subjectTags: ["synthetic.subject"],
      summary: "Synthetic course used only by automated tests.",
      termEndDate: "2026-08-31",
      termStartDate: options.startsOn ?? "2026-07-01",
      title: `Synthetic ${code}`,
      totalInstructionMinutes: 960,
      weeklyLoadMinutes: options.weeklyLoadMinutes ?? 120,
    },
    courseId,
    courseVersionId,
    version: 1,
  };
}

function rule(suffix: number, definition: CourseRuleDefinition): ApprovedCourseRule {
  return {
    ...definition,
    key: `synthetic.rule.${String(suffix)}`,
    ruleId: `30000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    ruleVersionId: `40000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    version: 1,
  };
}

function snapshot(
  rules: ApprovedCourseRule[],
  courses: ApprovedCourse[] = [
    course(courseAId, versionAId, "SYNTH_A"),
    course(courseBId, versionBId, "SYNTH_B", { startMinute: 660, endMinute: 720 }),
    course(courseCId, versionCId, "SYNTH_C", { weekday: 2 }),
  ],
): ApprovedCourseCatalogSnapshot {
  return ApprovedCourseCatalogSnapshotSchema.parse({ courses, rules });
}

describe("course catalog contracts", () => {
  it("requires scheduled courses to have non-overlapping sessions and paired term dates", () => {
    const content = course(courseAId, versionAId, "SYNTH_A").content;
    expect(CourseVersionContentSchema.safeParse(content).success).toBe(true);
    expect(
      CourseVersionContentSchema.safeParse({
        ...content,
        schedule: [
          { endMinute: 660, startMinute: 600, weekday: 1 },
          { endMinute: 700, startMinute: 650, weekday: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      CourseVersionContentSchema.safeParse({ ...content, termEndDate: undefined }).success,
    ).toBe(false);
  });

  it("keeps adjacent sessions valid and rejects fixed sessions on self-paced courses", () => {
    const content = course(courseAId, versionAId, "SYNTH_A").content;
    expect(
      CourseVersionContentSchema.safeParse({
        ...content,
        schedule: [
          { endMinute: 660, startMinute: 600, weekday: 1 },
          { endMinute: 720, startMinute: 660, weekday: 1 },
        ],
      }).success,
    ).toBe(true);
    expect(
      CourseVersionContentSchema.safeParse({ ...content, deliveryMode: "self_paced" }).success,
    ).toBe(false);
  });
});

describe("deterministic course rule evaluation", () => {
  it("accepts inclusive age and exact load boundaries when prerequisites are completed", () => {
    const catalog = snapshot([
      rule(1, {
        message: "Complete A before B.",
        requiredCourseId: courseAId,
        ruleType: "prerequisite",
        severity: "hard",
        subjectCourseId: courseBId,
      }),
      rule(2, {
        maxAge: 15,
        message: "B is for ages 12 through 15.",
        minAge: 12,
        ruleType: "age_range",
        severity: "hard",
        subjectCourseId: courseBId,
      }),
      rule(3, {
        maxConcurrentCourses: 1,
        maxWeeklyMinutes: 120,
        message: "Stay within the approved weekly load.",
        ruleType: "load_limit",
        severity: "hard",
      }),
    ]);
    const result = evaluateCourseSelection(catalog, {
      ageYears: 12,
      completedCourseIds: [courseAId],
      selectedCourseVersionIds: [versionBId],
    });
    expect(result).toMatchObject({ eligible: true, totalWeeklyLoadMinutes: 120, violations: [] });
  });

  it("blocks missing prerequisites even when the prerequisite is selected concurrently", () => {
    const catalog = snapshot([
      rule(1, {
        message: "Complete A before B.",
        requiredCourseId: courseAId,
        ruleType: "prerequisite",
        severity: "hard",
        subjectCourseId: courseBId,
      }),
    ]);
    const result = evaluateCourseSelection(catalog, {
      ageYears: 14,
      completedCourseIds: [],
      selectedCourseVersionIds: [versionAId, versionBId],
    });
    expect(result.eligible).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ ruleType: "prerequisite", severity: "hard" }),
    ]);
  });

  it("detects mutual exclusion in either selection order", () => {
    const catalog = snapshot([
      rule(1, {
        courseAId,
        courseBId,
        message: "A and B cannot run together.",
        ruleType: "mutual_exclusion",
        severity: "hard",
      }),
    ]);
    const result = evaluateCourseSelection(catalog, {
      ageYears: 14,
      completedCourseIds: [],
      selectedCourseVersionIds: [versionBId, versionAId],
    });
    expect(result.violations[0]).toMatchObject({
      courseIds: [courseAId, courseBId],
      ruleType: "mutual_exclusion",
    });
  });

  it("flags ages outside the range but accepts both inclusive boundaries", () => {
    const catalog = snapshot([
      rule(1, {
        maxAge: 15,
        message: "A is for ages 12 through 15.",
        minAge: 12,
        ruleType: "age_range",
        severity: "hard",
        subjectCourseId: courseAId,
      }),
    ]);
    for (const ageYears of [12, 15]) {
      expect(
        evaluateCourseSelection(catalog, {
          ageYears,
          completedCourseIds: [],
          selectedCourseVersionIds: [versionAId],
        }).eligible,
      ).toBe(true);
    }
    for (const ageYears of [11, 16]) {
      expect(
        evaluateCourseSelection(catalog, {
          ageYears,
          completedCourseIds: [],
          selectedCourseVersionIds: [versionAId],
        }).violations[0]?.ruleType,
      ).toBe("age_range");
    }
  });

  it("detects overlapping scheduled sessions but permits adjacent sessions", () => {
    const timeRule = rule(1, {
      message: "Selected courses overlap in time.",
      ruleType: "time_conflict",
      severity: "hard",
    });
    const overlapping = snapshot(
      [timeRule],
      [
        course(courseAId, versionAId, "SYNTH_A"),
        course(courseBId, versionBId, "SYNTH_B", { startMinute: 650, endMinute: 700 }),
      ],
    );
    expect(
      evaluateCourseSelection(overlapping, {
        ageYears: 14,
        completedCourseIds: [],
        selectedCourseVersionIds: [versionAId, versionBId],
      }).violations[0]?.ruleType,
    ).toBe("time_conflict");

    const adjacent = snapshot([timeRule]);
    expect(
      evaluateCourseSelection(adjacent, {
        ageYears: 14,
        completedCourseIds: [],
        selectedCourseVersionIds: [versionAId, versionBId],
      }).eligible,
    ).toBe(true);
  });

  it("detects weekly and concurrent load excess while treating warning rules as non-blocking", () => {
    const catalog = snapshot([
      rule(1, {
        maxConcurrentCourses: 1,
        maxWeeklyMinutes: 200,
        message: "The selected load exceeds the limit.",
        ruleType: "load_limit",
        severity: "warning",
      }),
    ]);
    const result = evaluateCourseSelection(catalog, {
      ageYears: 14,
      completedCourseIds: [],
      selectedCourseVersionIds: [versionAId, versionBId],
    });
    expect(result).toMatchObject({ eligible: true, totalWeeklyLoadMinutes: 240 });
    expect(result.violations[0]).toMatchObject({ ruleType: "load_limit", severity: "warning" });
  });

  it("reports combined hard violations without letting one rule hide another", () => {
    const catalog = snapshot([
      rule(1, {
        message: "Complete A before B.",
        requiredCourseId: courseAId,
        ruleType: "prerequisite",
        severity: "hard",
        subjectCourseId: courseBId,
      }),
      rule(2, {
        maxAge: 12,
        message: "B has an age cap.",
        ruleType: "age_range",
        severity: "hard",
        subjectCourseId: courseBId,
      }),
      rule(3, {
        maxWeeklyMinutes: 100,
        message: "Weekly load is too high.",
        ruleType: "load_limit",
        severity: "hard",
      }),
    ]);
    const result = evaluateCourseSelection(catalog, {
      ageYears: 14,
      completedCourseIds: [],
      selectedCourseVersionIds: [versionBId],
    });
    expect(result.violations.map((violation) => violation.ruleType)).toEqual([
      "prerequisite",
      "age_range",
      "load_limit",
    ]);
    expect(result.eligible).toBe(false);
  });

  it("rejects duplicate, contradictory, impossible-age and cyclic rule sets", () => {
    const prerequisite = rule(1, {
      message: "A requires B.",
      requiredCourseId: courseBId,
      ruleType: "prerequisite",
      severity: "hard",
      subjectCourseId: courseAId,
    });
    const issues = validateCourseRuleSet(
      snapshot([
        prerequisite,
        {
          ...prerequisite,
          key: "synthetic.rule.2",
          ruleId: "30000000-0000-4000-8000-000000000002",
          ruleVersionId: "40000000-0000-4000-8000-000000000002",
        },
        rule(3, {
          courseAId,
          courseBId,
          message: "A excludes B.",
          ruleType: "mutual_exclusion",
          severity: "hard",
        }),
        rule(4, {
          maxAge: 10,
          message: "A upper age.",
          ruleType: "age_range",
          severity: "hard",
          subjectCourseId: courseAId,
        }),
        rule(5, {
          message: "A lower age.",
          minAge: 12,
          ruleType: "age_range",
          severity: "hard",
          subjectCourseId: courseAId,
        }),
        rule(6, {
          message: "B requires A.",
          requiredCourseId: courseAId,
          ruleType: "prerequisite",
          severity: "hard",
          subjectCourseId: courseBId,
        }),
      ]),
    );
    expect(issues.some((issue) => issue.startsWith("duplicate_rule:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("prerequisite_mutex_conflict:"))).toBe(true);
    expect(issues).toContain(`age_range_conflict:${courseAId}`);
    expect(issues.some((issue) => issue.startsWith("prerequisite_cycle:"))).toBe(true);
  });

  it("refuses evaluation when rules conflict or a selected version is not approved", () => {
    const cyclic = snapshot([
      rule(1, {
        message: "A requires B.",
        requiredCourseId: courseBId,
        ruleType: "prerequisite",
        severity: "hard",
        subjectCourseId: courseAId,
      }),
      rule(2, {
        message: "B requires A.",
        requiredCourseId: courseAId,
        ruleType: "prerequisite",
        severity: "hard",
        subjectCourseId: courseBId,
      }),
    ]);
    expect(() =>
      evaluateCourseSelection(cyclic, {
        ageYears: 14,
        completedCourseIds: [],
        selectedCourseVersionIds: [versionAId],
      }),
    ).toThrow(CourseRuleConfigurationError);
    expect(() =>
      evaluateCourseSelection(snapshot([]), {
        ageYears: 14,
        completedCourseIds: [],
        selectedCourseVersionIds: ["20000000-0000-4000-8000-000000000099"],
      }),
    ).toThrow(CourseCatalogConflictError);
    expect(() =>
      evaluateCourseSelection(snapshot([]), {
        ageYears: 14,
        completedCourseIds: [courseAId],
        selectedCourseVersionIds: [versionAId],
      }),
    ).toThrow("A completed course cannot be selected again.");
  });
});
