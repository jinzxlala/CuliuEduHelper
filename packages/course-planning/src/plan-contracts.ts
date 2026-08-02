import { z } from "zod";

import {
  ApprovedCourseCatalogSnapshotSchema,
  CourseSelectionResultSchema,
  CourseRuleViolationSchema,
} from "./contracts.js";

const UniqueUuidArraySchema = (minimum: number, maximum: number): z.ZodType<string[]> =>
  z
    .array(z.uuid())
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "IDs must be unique.");

const UniqueTextArraySchema = (minimum: number, maximum: number): z.ZodType<string[]> =>
  z
    .array(z.string().trim().min(1).max(500))
    .min(minimum)
    .max(maximum)
    .refine(
      (values) =>
        new Set(values.map((value) => value.toLocaleLowerCase("zh-CN"))).size === values.length,
      "Values must be unique.",
    );

export const PlanStatusSchema = z.enum([
  "draft",
  "in_review",
  "approved",
  "needs_review",
  "archived",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanDateRangeSchema = z
  .object({ endDate: z.iso.date(), startDate: z.iso.date() })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    message: "The end date cannot be before the start date.",
    path: ["endDate"],
  });

const EvidenceBackedTextSchema = z
  .object({
    statement: z.string().trim().min(1).max(2_000),
    supportingClaimIds: UniqueUuidArraySchema(1, 20),
  })
  .strict();

export const PlanShortTermItemSchema = z
  .object({
    courseVersionId: z.uuid(),
    expectedOutcome: z.string().trim().min(1).max(1_000),
    order: z.number().int().min(1).max(3),
    period: PlanDateRangeSchema,
    reason: z.string().trim().min(1).max(2_000),
    risks: UniqueTextArraySchema(0, 10),
    supportingClaimIds: UniqueUuidArraySchema(1, 20),
  })
  .strict();

export const PlanRoutePhaseSchema = z
  .object({
    courseVersionIds: UniqueUuidArraySchema(1, 10),
    label: z.string().trim().min(1).max(200),
    period: PlanDateRangeSchema,
    sequence: z.number().int().min(1).max(20),
  })
  .strict();

export const PlanRouteSchema = z
  .object({
    key: z.enum(["route_a", "route_b"]),
    name: z.string().trim().min(1).max(200),
    phases: z.array(PlanRoutePhaseSchema).min(1).max(20),
    summary: z.string().trim().min(1).max(2_000),
    supportingClaimIds: UniqueUuidArraySchema(1, 20),
  })
  .strict()
  .superRefine((route, context) => {
    const sequences = route.phases.map((phase) => phase.sequence);
    if (!sequences.every((sequence, index) => sequence === index + 1)) {
      context.addIssue({
        code: "custom",
        message: "Route phase sequences must be contiguous and ordered from one.",
        path: ["phases"],
      });
    }
    const courseVersionIds = route.phases.flatMap((phase) => phase.courseVersionIds);
    if (new Set(courseVersionIds).size !== courseVersionIds.length) {
      context.addIssue({
        code: "custom",
        message: "A route cannot repeat a course version.",
        path: ["phases"],
      });
    }
    for (let index = 1; index < route.phases.length; index += 1) {
      const previous = route.phases[index - 1];
      const current = route.phases[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.period.startDate <= previous.period.endDate
      ) {
        context.addIssue({
          code: "custom",
          message: "Route phases must be chronological and non-overlapping.",
          path: ["phases", index, "period"],
        });
      }
    }
  });

export const PlanRouteComparisonSchema = z
  .object({
    dimension: z.string().trim().min(1).max(200),
    routeA: z.string().trim().min(1).max(1_000),
    routeB: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const PlanDecisionPointSchema = z
  .object({
    decisionQuestion: z.string().trim().min(1).max(1_000),
    observableSignals: UniqueTextArraySchema(1, 12),
    period: PlanDateRangeSchema,
  })
  .strict();

export const ManualPlanContentSchema = z
  .object({
    classroomProfile: EvidenceBackedTextSchema,
    decisionTimeline: z.array(PlanDecisionPointSchema).min(1).max(12),
    goal: z.string().trim().min(1).max(2_000),
    overlapAndGaps: z
      .object({
        overlap: UniqueTextArraySchema(1, 20),
        routeAGaps: UniqueTextArraySchema(0, 20),
        routeBGaps: UniqueTextArraySchema(0, 20),
      })
      .strict(),
    period: PlanDateRangeSchema,
    risks: UniqueTextArraySchema(1, 20),
    routeComparison: z.array(PlanRouteComparisonSchema).min(6).max(20),
    routes: z.array(PlanRouteSchema).length(2),
    shortTermItems: z.array(PlanShortTermItemSchema).min(1).max(3),
    title: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((plan, context) => {
    const shortTermOrders = plan.shortTermItems.map((item) => item.order);
    if (!shortTermOrders.every((order, index) => order === index + 1)) {
      context.addIssue({
        code: "custom",
        message: "Short-term items must be ordered contiguously from one.",
        path: ["shortTermItems"],
      });
    }
    const shortTermCourseVersionIds = plan.shortTermItems.map((item) => item.courseVersionId);
    if (new Set(shortTermCourseVersionIds).size !== shortTermCourseVersionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Short-term items cannot repeat a course version.",
        path: ["shortTermItems"],
      });
    }
    if (plan.routes[0]?.key !== "route_a" || plan.routes[1]?.key !== "route_b") {
      context.addIssue({
        code: "custom",
        message: "The two neutral routes must be ordered as route_a and route_b.",
        path: ["routes"],
      });
    }
    const dimensions = plan.routeComparison.map((item) =>
      item.dimension.toLocaleLowerCase("zh-CN"),
    );
    if (new Set(dimensions).size !== dimensions.length) {
      context.addIssue({
        code: "custom",
        message: "Route comparison dimensions must be unique.",
        path: ["routeComparison"],
      });
    }
    const ranges = [
      ...plan.shortTermItems.map((item) => item.period),
      ...plan.routes.flatMap((route) => route.phases.map((phase) => phase.period)),
      ...plan.decisionTimeline.map((decision) => decision.period),
    ];
    if (
      ranges.some(
        (range) => range.startDate < plan.period.startDate || range.endDate > plan.period.endDate,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "All plan dates must stay inside the plan period.",
        path: ["period"],
      });
    }
  });
export type ManualPlanContent = z.infer<typeof ManualPlanContentSchema>;

export const ManualPlanStudentInputSchema = z
  .object({
    ageYears: z.number().int().min(3).max(100),
    classroomFeedback: z.array(EvidenceBackedTextSchema).min(1).max(20),
    completedCourseIds: UniqueUuidArraySchema(0, 500),
    constraints: UniqueTextArraySchema(0, 30),
    inProgressCourseVersionIds: UniqueUuidArraySchema(0, 40),
    interests: UniqueTextArraySchema(1, 30),
  })
  .strict();
export type ManualPlanStudentInput = z.infer<typeof ManualPlanStudentInputSchema>;

export const CreateManualPlanInputSchema = z
  .object({
    content: ManualPlanContentSchema,
    profileVersionId: z.uuid(),
    reviewDueDate: z.iso.date(),
    sourcePlanVersionId: z.uuid().optional(),
    studentInput: ManualPlanStudentInputSchema,
  })
  .strict();
export type CreateManualPlanInput = z.infer<typeof CreateManualPlanInputSchema>;

export const PlanViolationSchema = CourseRuleViolationSchema.extend({
  violationKey: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type PlanViolation = z.infer<typeof PlanViolationSchema>;

export const PlanEvaluationScopeSchema = z
  .object({
    completedCourseIds: UniqueUuidArraySchema(0, 500),
    label: z.string().trim().min(1).max(200),
    result: CourseSelectionResultSchema.omit({ violations: true }).extend({
      violations: z.array(PlanViolationSchema).max(200),
    }),
    scopeKey: z.string().regex(/^(?:short_term|route_[ab]_phase_[1-9][0-9]*)$/u),
  })
  .strict();

export const PlanEvaluationSnapshotSchema = z
  .object({
    evaluatedAt: z.iso.datetime({ offset: true }),
    hardViolationCount: z.number().int().nonnegative(),
    scopes: z.array(PlanEvaluationScopeSchema).min(3).max(41),
    warningCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((evaluation, context) => {
    const violations = evaluation.scopes.flatMap((scope) => scope.result.violations);
    const hardCount = violations.filter((violation) => violation.severity === "hard").length;
    const warningCount = violations.filter((violation) => violation.severity === "warning").length;
    if (hardCount !== evaluation.hardViolationCount || warningCount !== evaluation.warningCount) {
      context.addIssue({ code: "custom", message: "Violation counts do not match scope results." });
    }
    const scopeKeys = evaluation.scopes.map((scope) => scope.scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({ code: "custom", message: "Evaluation scope keys must be unique." });
    }
  });
export type PlanEvaluationSnapshot = z.infer<typeof PlanEvaluationSnapshotSchema>;

export const FrozenPlanCatalogSchema = ApprovedCourseCatalogSnapshotSchema;
export type FrozenPlanCatalog = z.infer<typeof FrozenPlanCatalogSchema>;

const ExpectedUpdatedAtSchema = z.iso.datetime({ offset: true });
export const PlanTransitionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), expectedUpdatedAt: ExpectedUpdatedAtSchema }).strict(),
  z
    .object({
      action: z.literal("return"),
      expectedUpdatedAt: ExpectedUpdatedAtSchema,
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
  z.object({ action: z.literal("approve"), expectedUpdatedAt: ExpectedUpdatedAtSchema }).strict(),
  z
    .object({
      action: z.literal("archive"),
      expectedUpdatedAt: ExpectedUpdatedAtSchema,
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type PlanTransitionInput = z.infer<typeof PlanTransitionInputSchema>;

export const RequestPlanRuleOverrideInputSchema = z
  .object({
    expectedPlanUpdatedAt: ExpectedUpdatedAtSchema,
    reason: z.string().trim().min(1).max(1_000),
    scopeKey: z.string().regex(/^(?:short_term|route_[ab]_phase_[1-9][0-9]*)$/u),
    violationKey: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type RequestPlanRuleOverrideInput = z.infer<typeof RequestPlanRuleOverrideInputSchema>;

export const DecidePlanRuleOverrideInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), expectedUpdatedAt: ExpectedUpdatedAtSchema }).strict(),
  z
    .object({
      action: z.literal("reject"),
      expectedUpdatedAt: ExpectedUpdatedAtSchema,
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type DecidePlanRuleOverrideInput = z.infer<typeof DecidePlanRuleOverrideInputSchema>;

export const PlanRuleOverrideStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const StoredManualPlanSchema = z
  .object({
    approvedAt: z.date().nullable(),
    approvedByUserId: z.uuid().nullable(),
    catalogSnapshot: FrozenPlanCatalogSchema,
    catalogSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    content: ManualPlanContentSchema,
    createdAt: z.date(),
    createdByUserId: z.uuid(),
    evaluation: PlanEvaluationSnapshotSchema,
    id: z.uuid(),
    inputSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    invalidationReason: z.string().nullable(),
    profileVersionId: z.uuid(),
    reviewDueDate: z.iso.date(),
    sourcePlanVersionId: z.uuid().nullable(),
    status: PlanStatusSchema,
    studentId: z.uuid(),
    studentInput: ManualPlanStudentInputSchema,
    updatedAt: z.date(),
    version: z.number().int().positive(),
  })
  .strict();
export type StoredManualPlan = z.infer<typeof StoredManualPlanSchema>;
