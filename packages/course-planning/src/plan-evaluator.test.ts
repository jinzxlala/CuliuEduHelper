import { describe, expect, it } from "vitest";

import type { ApprovedCourse, ApprovedCourseCatalogSnapshot } from "./contracts.js";
import { CourseCatalogConflictError } from "./errors.js";
import {
  ManualPlanContentSchema,
  ManualPlanStudentInputSchema,
  type ManualPlanContent,
  type ManualPlanStudentInput,
} from "./plan-contracts.js";
import {
  evaluateManualPlan,
  hashPlanValue,
  selectRelevantPlanCatalog,
  stablePlanJson,
} from "./plan-evaluator.js";

const IDS = {
  claim: "10000000-0000-4000-8000-000000000001",
  courseA: "20000000-0000-4000-8000-000000000001",
  courseAVersion: "30000000-0000-4000-8000-000000000001",
  courseB: "20000000-0000-4000-8000-000000000002",
  courseBVersion: "30000000-0000-4000-8000-000000000002",
  courseC: "20000000-0000-4000-8000-000000000003",
  courseCVersion: "30000000-0000-4000-8000-000000000003",
  courseD: "20000000-0000-4000-8000-000000000004",
  courseDVersion: "30000000-0000-4000-8000-000000000004",
  ruleAge: "40000000-0000-4000-8000-000000000001",
  ruleAgeVersion: "50000000-0000-4000-8000-000000000001",
  ruleLoad: "40000000-0000-4000-8000-000000000002",
  ruleLoadVersion: "50000000-0000-4000-8000-000000000002",
  rulePrerequisite: "40000000-0000-4000-8000-000000000003",
  rulePrerequisiteVersion: "50000000-0000-4000-8000-000000000003",
} as const;

function course(courseId: string, courseVersionId: string, code: string): ApprovedCourse {
  return {
    code,
    content: {
      capabilityTags: ["reasoning"],
      deliverables: ["作品"],
      deliveryMode: "self_paced",
      difficulty: "foundation",
      durationWeeks: 8,
      notSuitableConditions: [],
      objectives: ["建立基础"],
      projectTypes: [],
      schedule: [],
      stage: "基础",
      subjectTags: ["cs"],
      summary: `${code} 课程`,
      title: `${code} 标题`,
      totalInstructionMinutes: 960,
      weeklyLoadMinutes: 120,
    },
    courseId,
    courseVersionId,
    version: 1,
  };
}

function catalog(): ApprovedCourseCatalogSnapshot {
  return {
    courses: [
      course(IDS.courseA, IDS.courseAVersion, "COURSE_A"),
      course(IDS.courseB, IDS.courseBVersion, "COURSE_B"),
      course(IDS.courseC, IDS.courseCVersion, "COURSE_C"),
      course(IDS.courseD, IDS.courseDVersion, "COURSE_D"),
    ],
    rules: [
      {
        key: "course-a.age",
        message: "建议满 16 岁后学习。",
        minAge: 16,
        ruleId: IDS.ruleAge,
        ruleType: "age_range",
        ruleVersionId: IDS.ruleAgeVersion,
        severity: "warning",
        subjectCourseId: IDS.courseA,
        version: 1,
      },
      {
        key: "global.load",
        maxConcurrentCourses: 2,
        maxWeeklyMinutes: 300,
        message: "同期课程负荷过高。",
        ruleId: IDS.ruleLoad,
        ruleType: "load_limit",
        ruleVersionId: IDS.ruleLoadVersion,
        severity: "hard",
        version: 1,
      },
      {
        key: "course-a.prerequisite",
        message: "课程 A 需要先完成课程 B。",
        requiredCourseId: IDS.courseB,
        ruleId: IDS.rulePrerequisite,
        ruleType: "prerequisite",
        ruleVersionId: IDS.rulePrerequisiteVersion,
        severity: "hard",
        subjectCourseId: IDS.courseA,
        version: 1,
      },
    ],
  };
}

function content(): ManualPlanContent {
  return ManualPlanContentSchema.parse({
    classroomProfile: {
      statement: "学生在结构化推理任务中表现稳定。",
      supportingClaimIds: [IDS.claim],
    },
    decisionTimeline: [
      {
        decisionQuestion: "是否继续提高课程难度？",
        observableSignals: ["能够独立完成阶段作品"],
        period: { endDate: "2026-09-30", startDate: "2026-09-01" },
      },
    ],
    goal: "验证学生能否把推理能力迁移到独立项目。",
    overlapAndGaps: {
      overlap: ["两条路线都训练推理和表达"],
      routeAGaps: ["需要补足工程实现"],
      routeBGaps: ["需要补足开放题探索"],
    },
    period: { endDate: "2027-06-30", startDate: "2026-08-01" },
    risks: ["课程节奏需要根据作品完成度复查"],
    routeComparison: Array.from({ length: 6 }, (_, index) => ({
      dimension: `维度 ${String(index + 1)}`,
      routeA: `路线 A 观察 ${String(index + 1)}`,
      routeB: `路线 B 观察 ${String(index + 1)}`,
    })),
    routes: [
      {
        key: "route_a",
        name: "路线 A：项目实践",
        phases: [
          {
            courseVersionIds: [IDS.courseCVersion],
            label: "项目基础",
            period: { endDate: "2026-12-31", startDate: "2026-10-01" },
            sequence: 1,
          },
        ],
        summary: "先通过项目任务观察持续投入。",
        supportingClaimIds: [IDS.claim],
      },
      {
        key: "route_b",
        name: "路线 B：递进学习",
        phases: [
          {
            courseVersionIds: [IDS.courseBVersion],
            label: "先修基础",
            period: { endDate: "2026-12-31", startDate: "2026-10-01" },
            sequence: 1,
          },
          {
            courseVersionIds: [IDS.courseAVersion],
            label: "进阶课程",
            period: { endDate: "2027-04-30", startDate: "2027-01-01" },
            sequence: 2,
          },
        ],
        summary: "用清晰的先修顺序降低学习断层。",
        supportingClaimIds: [IDS.claim],
      },
    ],
    shortTermItems: [
      {
        courseVersionId: IDS.courseAVersion,
        expectedOutcome: "完成一份结构化作品。",
        order: 1,
        period: { endDate: "2026-09-30", startDate: "2026-08-01" },
        reason: "用于验证画像中已经观察到的推理能力。",
        risks: ["先修基础尚未确认"],
        supportingClaimIds: [IDS.claim],
      },
    ],
    title: "测试课程规划",
  });
}

function studentInput(): ManualPlanStudentInput {
  return {
    ageYears: 15,
    classroomFeedback: [
      { statement: "课堂上能够解释自己的选择。", supportingClaimIds: [IDS.claim] },
    ],
    completedCourseIds: [],
    constraints: ["每周可投入时间有限"],
    inProgressCourseVersionIds: [IDS.courseDVersion],
    interests: ["编程项目"],
  };
}

describe("manual plan contracts and evaluation", () => {
  it("requires two ordered routes and at least six comparison dimensions", () => {
    const invalid = { ...content(), routeComparison: content().routeComparison.slice(0, 5) };
    expect(ManualPlanContentSchema.safeParse(invalid).success).toBe(false);
  });

  it("freezes only applicable catalog records and evaluates each route phase", () => {
    const snapshot = selectRelevantPlanCatalog(catalog(), content(), studentInput());
    expect(snapshot.courses).toHaveLength(4);
    expect(snapshot.rules.map((rule) => rule.key)).toEqual([
      "course-a.age",
      "global.load",
      "course-a.prerequisite",
    ]);

    const evaluation = evaluateManualPlan(
      snapshot,
      content(),
      studentInput(),
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const shortTerm = evaluation.scopes.find((scope) => scope.scopeKey === "short_term");
    const routeBPhase2 = evaluation.scopes.find((scope) => scope.scopeKey === "route_b_phase_2");
    expect(shortTerm?.result.violations.map((violation) => violation.ruleType).sort()).toEqual([
      "age_range",
      "prerequisite",
    ]);
    expect(routeBPhase2?.completedCourseIds).toContain(IDS.courseB);
    expect(routeBPhase2?.result.violations.map((violation) => violation.ruleType)).toEqual([
      "age_range",
    ]);
    expect(evaluation.hardViolationCount).toBe(1);
    expect(evaluation.warningCount).toBe(2);
  });

  it("rejects planning an in-progress or completed course again", () => {
    const duplicatedInput = {
      ...studentInput(),
      inProgressCourseVersionIds: [IDS.courseAVersion],
    };
    expect(() => selectRelevantPlanCatalog(catalog(), content(), duplicatedInput)).toThrow(
      CourseCatalogConflictError,
    );

    const completedInput = { ...studentInput(), completedCourseIds: [IDS.courseA] };
    expect(() => selectRelevantPlanCatalog(catalog(), content(), completedInput)).toThrow(
      CourseCatalogConflictError,
    );
  });

  it("requires a scheduled plan period to contain the approved course term", () => {
    const scheduledCatalog = catalog();
    const scheduledCourse = scheduledCatalog.courses.find(
      (entry) => entry.courseVersionId === IDS.courseAVersion,
    );
    if (scheduledCourse === undefined) throw new Error("Missing course fixture.");
    scheduledCourse.content = {
      ...scheduledCourse.content,
      deliveryMode: "scheduled",
      schedule: [{ endMinute: 660, startMinute: 600, weekday: 6 }],
      termEndDate: "2026-10-31",
      termStartDate: "2026-09-01",
    };

    expect(() => selectRelevantPlanCatalog(scheduledCatalog, content(), studentInput())).toThrow(
      "A scheduled plan item must contain the approved course offering dates.",
    );
  });

  it("bounds the in-progress snapshot to the evaluator capacity", () => {
    expect(
      ManualPlanStudentInputSchema.safeParse({
        ...studentInput(),
        inProgressCourseVersionIds: Array.from(
          { length: 41 },
          (_, index) => `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("produces stable hashes independent of object key order", () => {
    expect(hashPlanValue({ a: 1, b: [2, 3] })).toBe(hashPlanValue({ b: [2, 3], a: 1 }));
    expect(stablePlanJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
