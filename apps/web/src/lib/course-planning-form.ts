import {
  type ApprovedCourseCatalogSnapshot,
  type CreateManualPlanInput,
  type StoredManualPlan,
} from "@culiu/course-planning";
import { CreateManualPlanInputSchema } from "@culiu/course-planning/contracts";

export type DateValue = Date | string;

export interface PlanningProfileView {
  claims: Array<{
    category: string;
    confidence: "high" | "low" | "medium" | "unknown";
    id: string;
    informationNature: "advisor_judgment" | "fact" | "inference" | "missing";
    statement: string;
  }>;
  id: string;
  updatedAt: DateValue;
  version: number;
}

export interface PlanOverrideView {
  createdAt: DateValue;
  decidedAt: DateValue | null;
  decidedByDisplayName: string | null;
  decisionReason: string | null;
  id: string;
  reason: string;
  requestedByDisplayName: string;
  scopeKey: string;
  status: "approved" | "pending" | "rejected";
  updatedAt: DateValue;
  violationKey: string;
}

export interface PlanReviewView {
  action: "approved" | "archived" | "created" | "invalidated" | "returned" | "submitted";
  actorDisplayName: string | null;
  actorType: "service" | "user";
  createdAt: DateValue;
  fromStatus: StoredManualPlan["status"] | null;
  id: string;
  reason: string | null;
  toStatus: StoredManualPlan["status"];
}

export type PlanWorkspaceItem = Omit<StoredManualPlan, "createdAt" | "updatedAt"> & {
  createdAt: DateValue;
  overrides: PlanOverrideView[];
  reviews: PlanReviewView[];
  updatedAt: DateValue;
};

export interface PlanningWorkspaceData {
  approvedProfile: PlanningProfileView | null;
  catalog: ApprovedCourseCatalogSnapshot;
  plans: PlanWorkspaceItem[];
  studentId: string;
}

export interface PlanCourseItemDraft {
  courseVersionId: string;
  endDate: string;
  expectedOutcome: string;
  reason: string;
  risksText: string;
  startDate: string;
}

export interface PlanRoutePhaseDraft {
  courseVersionIds: string[];
  endDate: string;
  label: string;
  startDate: string;
}

export interface PlanRouteDraft {
  name: string;
  phases: PlanRoutePhaseDraft[];
  summary: string;
}

export interface PlanComparisonDraft {
  dimension: string;
  routeA: string;
  routeB: string;
}

export interface ManualPlanFormState {
  ageYears: string;
  classroomFeedback: string;
  classroomProfile: string;
  completedCourseIds: string[];
  constraintsText: string;
  decisionEndDate: string;
  decisionQuestion: string;
  decisionSignalsText: string;
  decisionStartDate: string;
  goal: string;
  inProgressCourseVersionIds: string[];
  interestsText: string;
  overlapText: string;
  planEndDate: string;
  planStartDate: string;
  reviewDueDate: string;
  risksText: string;
  routeAGapsText: string;
  routeBGapsText: string;
  routeComparison: PlanComparisonDraft[];
  routes: [PlanRouteDraft, PlanRouteDraft];
  shortTermItems: PlanCourseItemDraft[];
  supportingClaimIds: string[];
  title: string;
}

const defaultDimensions = ["学习目标", "课程节奏", "实践方式", "能力侧重", "时间投入", "观察信号"];

function dateAfter(base: Date, days: number): string {
  const value = new Date(base);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function lines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function cloneLatestPlan(plan: PlanWorkspaceItem): ManualPlanFormState {
  const firstDecision = plan.content.decisionTimeline[0];
  if (firstDecision === undefined) throw new Error("The stored plan has no decision point.");
  return {
    ageYears: String(plan.studentInput.ageYears),
    classroomFeedback: plan.studentInput.classroomFeedback.map((item) => item.statement).join("\n"),
    classroomProfile: plan.content.classroomProfile.statement,
    completedCourseIds: [...plan.studentInput.completedCourseIds],
    constraintsText: plan.studentInput.constraints.join("\n"),
    decisionEndDate: firstDecision.period.endDate,
    decisionQuestion: firstDecision.decisionQuestion,
    decisionSignalsText: firstDecision.observableSignals.join("\n"),
    decisionStartDate: firstDecision.period.startDate,
    goal: plan.content.goal,
    inProgressCourseVersionIds: [...plan.studentInput.inProgressCourseVersionIds],
    interestsText: plan.studentInput.interests.join("\n"),
    overlapText: plan.content.overlapAndGaps.overlap.join("\n"),
    planEndDate: plan.content.period.endDate,
    planStartDate: plan.content.period.startDate,
    reviewDueDate: plan.reviewDueDate,
    risksText: plan.content.risks.join("\n"),
    routeAGapsText: plan.content.overlapAndGaps.routeAGaps.join("\n"),
    routeBGapsText: plan.content.overlapAndGaps.routeBGaps.join("\n"),
    routeComparison: structuredClone(plan.content.routeComparison),
    routes: plan.content.routes.map((route) => ({
      name: route.name,
      phases: route.phases.map((phase) => ({
        courseVersionIds: [...phase.courseVersionIds],
        endDate: phase.period.endDate,
        label: phase.label,
        startDate: phase.period.startDate,
      })),
      summary: route.summary,
    })) as [PlanRouteDraft, PlanRouteDraft],
    shortTermItems: plan.content.shortTermItems.map((item) => ({
      courseVersionId: item.courseVersionId,
      endDate: item.period.endDate,
      expectedOutcome: item.expectedOutcome,
      reason: item.reason,
      risksText: item.risks.join("\n"),
      startDate: item.period.startDate,
    })),
    supportingClaimIds: [
      ...new Set([
        ...plan.content.classroomProfile.supportingClaimIds,
        ...plan.studentInput.classroomFeedback.flatMap((item) => item.supportingClaimIds),
      ]),
    ],
    title: plan.content.title,
  };
}

export function createManualPlanFormState(
  workspace: PlanningWorkspaceData,
  now = new Date(),
): ManualPlanFormState {
  const latest = workspace.plans[0];
  if (latest !== undefined) return cloneLatestPlan(latest);
  const claimId = workspace.approvedProfile?.claims.find(
    (claim) => claim.informationNature !== "missing",
  )?.id;
  const courseVersionId = workspace.catalog.courses[0]?.courseVersionId ?? "";
  const startDate = dateAfter(now, 1);
  const shortEndDate = dateAfter(now, 60);
  const decisionStartDate = dateAfter(now, 61);
  const decisionEndDate = dateAfter(now, 90);
  const routeStartDate = dateAfter(now, 91);
  const routeEndDate = dateAfter(now, 180);
  return {
    ageYears: "",
    classroomFeedback: "",
    classroomProfile: "",
    completedCourseIds: [],
    constraintsText: "",
    decisionEndDate,
    decisionQuestion: "到期复盘时，哪条路线更适合继续？",
    decisionSignalsText: "能独立完成阶段作品",
    decisionStartDate,
    goal: "",
    inProgressCourseVersionIds: [],
    interestsText: "",
    overlapText: "两条路线都需要持续观察学习投入与独立完成度",
    planEndDate: dateAfter(now, 365),
    planStartDate: startDate,
    reviewDueDate: dateAfter(now, 90),
    risksText: "课程实际开班时间或学生兴趣可能变化",
    routeAGapsText: "待补充",
    routeBGapsText: "待补充",
    routeComparison: defaultDimensions.map((dimension) => ({ dimension, routeA: "", routeB: "" })),
    routes: [
      {
        name: "路线 A",
        phases: [
          {
            courseVersionIds: courseVersionId ? [courseVersionId] : [],
            endDate: routeEndDate,
            label: "第一阶段",
            startDate: routeStartDate,
          },
        ],
        summary: "",
      },
      {
        name: "路线 B",
        phases: [
          {
            courseVersionIds: courseVersionId ? [courseVersionId] : [],
            endDate: routeEndDate,
            label: "第一阶段",
            startDate: routeStartDate,
          },
        ],
        summary: "",
      },
    ],
    shortTermItems: [
      {
        courseVersionId,
        endDate: shortEndDate,
        expectedOutcome: "",
        reason: "",
        risksText: "",
        startDate,
      },
    ],
    supportingClaimIds: claimId === undefined ? [] : [claimId],
    title: "",
  };
}

export function buildCreateManualPlanInput(
  state: ManualPlanFormState,
  workspace: PlanningWorkspaceData,
): CreateManualPlanInput {
  const profile = workspace.approvedProfile;
  if (profile === null) throw new Error("需要先批准一份学生画像。 ");
  const supportingClaimIds = [...new Set(state.supportingClaimIds)];
  const feedback = lines(state.classroomFeedback);
  const input = {
    content: {
      classroomProfile: { statement: state.classroomProfile, supportingClaimIds },
      decisionTimeline: [
        {
          decisionQuestion: state.decisionQuestion,
          observableSignals: lines(state.decisionSignalsText),
          period: { endDate: state.decisionEndDate, startDate: state.decisionStartDate },
        },
      ],
      goal: state.goal,
      overlapAndGaps: {
        overlap: lines(state.overlapText),
        routeAGaps: lines(state.routeAGapsText),
        routeBGaps: lines(state.routeBGapsText),
      },
      period: { endDate: state.planEndDate, startDate: state.planStartDate },
      risks: lines(state.risksText),
      routeComparison: state.routeComparison,
      routes: state.routes.map((route, routeIndex) => ({
        key: routeIndex === 0 ? ("route_a" as const) : ("route_b" as const),
        name: route.name,
        phases: route.phases.map((phase, phaseIndex) => ({
          courseVersionIds: phase.courseVersionIds,
          label: phase.label,
          period: { endDate: phase.endDate, startDate: phase.startDate },
          sequence: phaseIndex + 1,
        })),
        summary: route.summary,
        supportingClaimIds,
      })) as CreateManualPlanInput["content"]["routes"],
      shortTermItems: state.shortTermItems.map((item, index) => ({
        courseVersionId: item.courseVersionId,
        expectedOutcome: item.expectedOutcome,
        order: index + 1,
        period: { endDate: item.endDate, startDate: item.startDate },
        reason: item.reason,
        risks: lines(item.risksText),
        supportingClaimIds,
      })),
      title: state.title,
    },
    profileVersionId: profile.id,
    reviewDueDate: state.reviewDueDate,
    ...(workspace.plans[0] === undefined || workspace.plans[0].status === "archived"
      ? {}
      : { sourcePlanVersionId: workspace.plans[0].id }),
    studentInput: {
      ageYears: Number(state.ageYears),
      classroomFeedback: feedback.map((statement) => ({ statement, supportingClaimIds })),
      completedCourseIds: state.completedCourseIds,
      constraints: lines(state.constraintsText),
      inProgressCourseVersionIds: state.inProgressCourseVersionIds,
      interests: lines(state.interestsText),
    },
  };
  return CreateManualPlanInputSchema.parse(input);
}

export function toIsoString(value: DateValue): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
