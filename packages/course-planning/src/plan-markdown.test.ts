import { describe, expect, it } from "vitest";

import type { ApprovedCourse } from "./contracts.js";
import type { PlanEvaluationSnapshot } from "./plan-contracts.js";
import { hashPlanValue } from "./plan-evaluator.js";
import { renderManualPlanMarkdown } from "./plan-markdown.js";

const CLAIM_ID = "10000000-0000-4000-8000-000000000001";
const COURSE_A_ID = "20000000-0000-4000-8000-000000000001";
const COURSE_A_VERSION_ID = "30000000-0000-4000-8000-000000000001";
const COURSE_B_ID = "20000000-0000-4000-8000-000000000002";
const COURSE_B_VERSION_ID = "30000000-0000-4000-8000-000000000002";

function course(courseId: string, courseVersionId: string, code: string): ApprovedCourse {
  return {
    code,
    content: {
      capabilityTags: ["reasoning"],
      deliverables: ["作品"],
      deliveryMode: "self_paced" as const,
      difficulty: "foundation" as const,
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

function scope(
  scopeKey: "route_a_phase_1" | "route_b_phase_1" | "short_term",
  versionId: string,
): PlanEvaluationSnapshot["scopes"][number] {
  return {
    completedCourseIds: [],
    label: scopeKey,
    result: {
      eligible: true,
      selectedCourseVersionIds: [versionId],
      totalWeeklyLoadMinutes: 120,
      violations: [],
    },
    scopeKey,
  };
}

describe("deterministic manual plan Markdown", () => {
  it("renders approval metadata, numbered choices, two routes and an ASCII path deterministically", () => {
    const catalogSnapshot = {
      courses: [
        course(COURSE_A_ID, COURSE_A_VERSION_ID, "COURSE_A"),
        course(COURSE_B_ID, COURSE_B_VERSION_ID, "COURSE_B"),
      ],
      rules: [],
    };
    const content = {
      classroomProfile: {
        statement: "学生在结构化推理任务中表现稳定。",
        supportingClaimIds: [CLAIM_ID],
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
          key: "route_a" as const,
          name: "路线 A：项目实践",
          phases: [
            {
              courseVersionIds: [COURSE_A_VERSION_ID],
              label: "项目基础",
              period: { endDate: "2026-12-31", startDate: "2026-10-01" },
              sequence: 1,
            },
          ],
          summary: "先通过项目任务观察持续投入。",
          supportingClaimIds: [CLAIM_ID],
        },
        {
          key: "route_b" as const,
          name: "路线 B：递进学习",
          phases: [
            {
              courseVersionIds: [COURSE_B_VERSION_ID],
              label: "递进基础",
              period: { endDate: "2026-12-31", startDate: "2026-10-01" },
              sequence: 1,
            },
          ],
          summary: "用清晰顺序降低学习断层。",
          supportingClaimIds: [CLAIM_ID],
        },
      ],
      shortTermItems: [
        {
          courseVersionId: COURSE_A_VERSION_ID,
          expectedOutcome: "完成一份结构化作品。",
          order: 1,
          period: { endDate: "2026-09-30", startDate: "2026-08-01" },
          reason: "用于验证画像中已经观察到的推理能力。",
          risks: [],
          supportingClaimIds: [CLAIM_ID],
        },
      ],
      title: "测试课程规划",
    };
    const studentInput = {
      ageYears: 15,
      classroomFeedback: [
        { statement: "课堂上能够解释自己的选择。", supportingClaimIds: [CLAIM_ID] },
      ],
      completedCourseIds: [],
      constraints: [],
      inProgressCourseVersionIds: [],
      interests: ["编程项目"],
    };
    const evaluation = {
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      hardViolationCount: 0,
      scopes: [
        scope("short_term", COURSE_A_VERSION_ID),
        scope("route_a_phase_1", COURSE_A_VERSION_ID),
        scope("route_b_phase_1", COURSE_B_VERSION_ID),
      ],
      warningCount: 0,
    };
    const input = {
      approvedByDisplayName: "测试顾问",
      courses: catalogSnapshot.courses.map((item) => ({
        code: item.code,
        courseVersionId: item.courseVersionId,
        title: item.content.title,
      })),
      overrides: [],
      plan: {
        approvedAt: new Date("2026-08-02T08:00:00.000Z"),
        approvedByUserId: "60000000-0000-4000-8000-000000000001",
        catalogSnapshot,
        catalogSnapshotHash: hashPlanValue(catalogSnapshot),
        content,
        createdAt: new Date("2026-08-02T07:00:00.000Z"),
        createdByUserId: "60000000-0000-4000-8000-000000000001",
        evaluation,
        id: "70000000-0000-4000-8000-000000000001",
        inputSnapshotHash: "a".repeat(64),
        invalidationReason: null,
        profileVersionId: "80000000-0000-4000-8000-000000000001",
        reviewDueDate: "2027-01-31",
        sourcePlanVersionId: null,
        status: "approved" as const,
        studentId: "90000000-0000-4000-8000-000000000001",
        studentInput,
        updatedAt: new Date("2026-08-02T08:00:00.000Z"),
        version: 1,
      },
      profileClaims: { [CLAIM_ID]: "学生在结构化推理任务中表现稳定。" },
      studentPublicCode: "STUDENT-TEST",
    };
    const first = renderManualPlanMarkdown(input);
    expect(renderManualPlanMarkdown(input)).toBe(first);
    expect(first).toContain("# 测试课程规划");
    expect(first).toContain("### 并行路径图");
    expect(first).toContain("路线 A：项目实践:");
    expect(first).toContain("批准人：测试顾问");
    expect(first).toContain("生成日期：2026-08-02");
    expect(first).toContain("本文件未使用模型自动决定课程");
  });

  it("keeps advisor text from changing the Markdown structure", () => {
    const catalogSnapshot = {
      courses: [course(COURSE_A_ID, COURSE_A_VERSION_ID, "COURSE_A")],
      rules: [],
    };
    const unsafe = "正常内容\n## 注入标题 <script>alert(1)</script> [链接](https://example.com)";
    const baseContent = {
      classroomProfile: { statement: unsafe, supportingClaimIds: [CLAIM_ID] },
      decisionTimeline: [
        {
          decisionQuestion: unsafe,
          observableSignals: [unsafe],
          period: { endDate: "2026-09-30", startDate: "2026-09-01" },
        },
      ],
      goal: unsafe,
      overlapAndGaps: { overlap: [unsafe], routeAGaps: [], routeBGaps: [] },
      period: { endDate: "2027-06-30", startDate: "2026-08-01" },
      risks: [unsafe],
      routeComparison: Array.from({ length: 6 }, (_, index) => ({
        dimension: `维度 ${String(index + 1)}`,
        routeA: unsafe,
        routeB: unsafe,
      })),
      routes: [
        {
          key: "route_a" as const,
          name: unsafe,
          phases: [
            {
              courseVersionIds: [COURSE_A_VERSION_ID],
              label: unsafe,
              period: { endDate: "2026-12-31", startDate: "2026-10-01" },
              sequence: 1,
            },
          ],
          summary: unsafe,
          supportingClaimIds: [CLAIM_ID],
        },
        {
          key: "route_b" as const,
          name: "安全路线 B",
          phases: [
            {
              courseVersionIds: [COURSE_A_VERSION_ID],
              label: "安全阶段",
              period: { endDate: "2026-12-31", startDate: "2026-10-01" },
              sequence: 1,
            },
          ],
          summary: "安全说明",
          supportingClaimIds: [CLAIM_ID],
        },
      ],
      shortTermItems: [
        {
          courseVersionId: COURSE_A_VERSION_ID,
          expectedOutcome: unsafe,
          order: 1,
          period: { endDate: "2026-09-30", startDate: "2026-08-01" },
          reason: unsafe,
          risks: [unsafe],
          supportingClaimIds: [CLAIM_ID],
        },
      ],
      title: unsafe,
    };
    const studentInput = {
      ageYears: 15,
      classroomFeedback: [{ statement: "安全反馈", supportingClaimIds: [CLAIM_ID] }],
      completedCourseIds: [],
      constraints: [],
      inProgressCourseVersionIds: [],
      interests: ["编程项目"],
    };
    const evaluation = {
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      hardViolationCount: 0,
      scopes: [
        scope("short_term", COURSE_A_VERSION_ID),
        scope("route_a_phase_1", COURSE_A_VERSION_ID),
        scope("route_b_phase_1", COURSE_A_VERSION_ID),
      ],
      warningCount: 0,
    };
    const rendered = renderManualPlanMarkdown({
      approvedByDisplayName: unsafe,
      courses: catalogSnapshot.courses.map((item) => ({
        code: item.code,
        courseVersionId: item.courseVersionId,
        title: item.content.title,
      })),
      overrides: [],
      plan: {
        approvedAt: new Date("2026-08-02T08:00:00.000Z"),
        approvedByUserId: "60000000-0000-4000-8000-000000000001",
        catalogSnapshot,
        catalogSnapshotHash: hashPlanValue(catalogSnapshot),
        content: baseContent,
        createdAt: new Date("2026-08-02T07:00:00.000Z"),
        createdByUserId: "60000000-0000-4000-8000-000000000001",
        evaluation,
        id: "70000000-0000-4000-8000-000000000001",
        inputSnapshotHash: "a".repeat(64),
        invalidationReason: null,
        profileVersionId: "80000000-0000-4000-8000-000000000001",
        reviewDueDate: "2027-01-31",
        sourcePlanVersionId: null,
        status: "approved" as const,
        studentId: "90000000-0000-4000-8000-000000000001",
        studentInput,
        updatedAt: new Date("2026-08-02T08:00:00.000Z"),
        version: 1,
      },
      profileClaims: { [CLAIM_ID]: unsafe },
      studentPublicCode: "STUDENT-TEST",
    });

    expect(rendered).not.toContain("\n## 注入标题");
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("[链接](https://example.com)");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("\\[链接\\](https://example.com)");
  });
});
