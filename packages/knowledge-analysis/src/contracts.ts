import { z } from "zod";

// The workspace library can contain the complete current lecture/case catalog.
// Model context remains independently bounded by the deterministic compression
// rules in analysis-chat.ts and analysis-report.ts.
export const KNOWLEDGE_ANALYSIS_MAX_SOURCES = 500;
export const KNOWLEDGE_ANALYSIS_MAX_CONVERSATIONS = 50;
export const KNOWLEDGE_SMART_SEARCH_MAX_PLANS = 6;
export const KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES = 60;
export const KNOWLEDGE_SMART_SEARCH_MAX_RESULTS = 20;
export const KNOWLEDGE_SMART_SEARCH_MAX_FROZEN_RESULTS = 10_000;
export const KNOWLEDGE_SMART_SEARCH_MAX_ROUNDS = 2;

export const CreateSmartSearchInputSchema = z
  .object({ prompt: z.string().trim().min(1).max(1_000) })
  .strict();

const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const StableBlockIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_-]*$/u);

export const KnowledgeWorkspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type KnowledgeWorkspaceRole = z.infer<typeof KnowledgeWorkspaceRoleSchema>;

export const KnowledgeWorkspaceStatusSchema = z.enum(["active", "archived"]);
export type KnowledgeWorkspaceStatus = z.infer<typeof KnowledgeWorkspaceStatusSchema>;

export const KnowledgeSourceTypeSchema = z.enum(["lecture", "case"]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>;

export const KnowledgeSourceReferenceSchema = z
  .object({
    batchId: z.uuid(),
    contentHash: ContentHashSchema,
    sourceId: z.string().trim().min(1).max(511),
    sourceType: KnowledgeSourceTypeSchema,
  })
  .strict();
export type KnowledgeSourceReference = z.infer<typeof KnowledgeSourceReferenceSchema>;

export const SmartSearchIntentSchema = z.enum([
  "semantic_search",
  "catalog_browse",
  "count",
  "analysis_required",
]);
export type SmartSearchIntent = z.infer<typeof SmartSearchIntentSchema>;

export const SmartSearchTargetSchema = z.enum(["lectures", "cases"]);
export type SmartSearchTarget = z.infer<typeof SmartSearchTargetSchema>;

export const SmartSearchLectureFilterSchema = z
  .object({
    dateFrom: z.iso.date().nullable().default(null),
    dateBefore: z.iso.date().nullable().default(null),
    majors: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    organizations: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    schools: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    speakers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dateFrom !== null &&
      value.dateBefore !== null &&
      value.dateFrom >= value.dateBefore
    ) {
      context.addIssue({
        code: "custom",
        message: "Search dateFrom must be earlier than dateBefore.",
        path: ["dateBefore"],
      });
    }
  });

export const SmartSearchCaseFilterSchema = z
  .object({
    activityTypes: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    aiDepth: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    aiDomains: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    caseTypes: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    confidences: z
      .array(z.enum(["high", "medium", "low", "unknown"]))
      .max(4)
      .default([]),
    curriculumSystems: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    majors: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    researchMethods: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    schools: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    sourceDateBefore: z.iso.date().nullable().default(null),
    sourceDateFrom: z.iso.date().nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceDateFrom !== null &&
      value.sourceDateBefore !== null &&
      value.sourceDateFrom >= value.sourceDateBefore
    ) {
      context.addIssue({
        code: "custom",
        message: "Case sourceDateFrom must be earlier than sourceDateBefore.",
        path: ["sourceDateBefore"],
      });
    }
  });

const SmartSearchQueryFields = {
  keywords: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  matchingStrategy: z.enum(["last", "all"]).default("last"),
  query: z.string().trim().max(500).default(""),
} as const;

export const SmartSearchQueryPlanItemSchema = z.discriminatedUnion("target", [
  z
    .object({
      ...SmartSearchQueryFields,
      filters: SmartSearchLectureFilterSchema,
      target: z.literal("lectures"),
    })
    .strict(),
  z
    .object({
      ...SmartSearchQueryFields,
      filters: SmartSearchCaseFilterSchema,
      target: z.literal("cases"),
    })
    .strict(),
]);

export const SmartSearchQueryPlanSchema = z
  .object({
    intent: SmartSearchIntentSchema,
    interpretation: z.string().trim().min(1).max(2_000),
    queries: z.array(SmartSearchQueryPlanItemSchema).max(KNOWLEDGE_SMART_SEARCH_MAX_PLANS),
    round: z.number().int().min(1).max(KNOWLEDGE_SMART_SEARCH_MAX_ROUNDS),
    targets: z
      .array(SmartSearchTargetSchema)
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, "targets must be unique"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent === "analysis_required" && value.queries.length > 0) {
      context.addIssue({
        code: "custom",
        message: "analysis_required must not execute retrieval queries",
        path: ["queries"],
      });
    }
    if (value.intent !== "analysis_required" && value.queries.length === 0) {
      context.addIssue({
        code: "custom",
        message: "search and count intents require at least one query",
        path: ["queries"],
      });
    }
    for (const query of value.queries) {
      if (!value.targets.includes(query.target)) {
        context.addIssue({
          code: "custom",
          message: "query target must be declared in targets",
          path: ["targets"],
        });
      }
    }
  });
export type SmartSearchQueryPlan = z.infer<typeof SmartSearchQueryPlanSchema>;

export const SmartSearchCandidateReferenceSchema = KnowledgeSourceReferenceSchema.extend({
  matchedPlanIndexes: z.array(z.number().int().nonnegative()).min(1).max(6),
}).strict();

export const SmartSearchResultSchema = z
  .object({
    appliedConditions: z.array(z.string().trim().min(1).max(500)).max(30),
    caseCount: z.number().int().nonnegative(),
    exactTotal: z.number().int().nonnegative().nullable(),
    intent: SmartSearchIntentSchema,
    lectureCount: z.number().int().nonnegative(),
    limitations: z.array(z.string().trim().min(1).max(500)).max(10),
    results: z
      .array(
        KnowledgeSourceReferenceSchema.extend({
          matchedTerms: z.array(z.string().trim().min(1).max(80)).max(20),
          rationale: z.string().trim().min(1).max(1_500),
        }).strict(),
      )
      .max(KNOWLEDGE_SMART_SEARCH_MAX_FROZEN_RESULTS),
    summary: z.string().trim().min(1).max(3_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.intent === "semantic_search" &&
      value.results.length > KNOWLEDGE_SMART_SEARCH_MAX_RESULTS
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic_search may return at most 20 results",
        path: ["results"],
      });
    }
    if (["count", "analysis_required"].includes(value.intent) && value.results.length > 0) {
      context.addIssue({
        code: "custom",
        message: "count and analysis_required must not freeze result cards",
        path: ["results"],
      });
    }
  });
export type SmartSearchResult = z.infer<typeof SmartSearchResultSchema>;

export const CreateKnowledgeWorkspaceInputSchema = z
  .object({
    description: z.string().trim().max(2_000).default(""),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreateKnowledgeWorkspaceInput = z.input<typeof CreateKnowledgeWorkspaceInputSchema>;

export const UpdateKnowledgeWorkspaceInputSchema = z
  .object({
    description: z.string().trim().max(2_000).optional(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "At least one workspace field must be updated.",
  });

export const AddKnowledgeWorkspaceSourcesInputSchema = z
  .object({
    sources: z.array(KnowledgeSourceReferenceSchema).min(1).max(KNOWLEDGE_ANALYSIS_MAX_SOURCES),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    value.sources.forEach((source, index) => {
      const identity = `${source.batchId}:${source.sourceType}:${source.sourceId}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Workspace sources must be unique.",
          path: ["sources", index],
        });
      }
      identities.add(identity);
    });
  });

export const CreateKnowledgeConversationInputSchema = z
  .object({ title: z.string().trim().min(1).max(200).default("新对话") })
  .strict();

export const SetKnowledgeWorkspaceMemberInputSchema = z
  .object({
    role: z.enum(["editor", "viewer"]),
    userId: z.uuid(),
  })
  .strict();

export const KnowledgeWorkspaceIdSchema = z.uuid();
export const KnowledgeConversationIdSchema = z.uuid();
export const KnowledgeAnalysisSourceIdSchema = z.uuid();

export const KnowledgeCitationSchema = z
  .object({
    claim: z.string().trim().min(1).max(1_000),
    source: KnowledgeSourceReferenceSchema,
  })
  .strict();
export type KnowledgeCitation = z.infer<typeof KnowledgeCitationSchema>;

export const CreateKnowledgeMessageInputSchema = z
  .object({ content: z.string().trim().min(1).max(20_000) })
  .strict();

export const KnowledgeAssistantMessageSchema = z
  .object({
    answerMarkdown: z.string().trim().min(1).max(60_000),
    citations: z.array(KnowledgeCitationSchema).max(100),
    conversationTopic: z.string().trim().min(1).max(80),
    suggestedFollowUps: z.array(z.string().trim().min(1).max(500)).max(8),
    uncertainties: z.array(z.string().trim().min(1).max(1_000)).max(20),
  })
  .strict();

export const AnalysisReportRequestSchema = z
  .object({
    requirements: z.string().trim().max(4_000).default(""),
    supersedesReportId: z.uuid().optional(),
  })
  .strict();

const AnalysisReportMetricSchema = z
  .object({
    detail: z.string().trim().max(500).default(""),
    label: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(120),
  })
  .strict();

const AnalysisChartPointSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    sourceIds: z.array(z.string().trim().min(1).max(511)).max(100),
    value: z.number(),
  })
  .strict();

const AnalysisChartSchema = z
  .object({
    points: z.array(AnalysisChartPointSchema).min(1).max(100),
    title: z.string().trim().min(1).max(200),
    type: z.enum(["bar", "line", "pie"]),
  })
  .strict();

export const AnalysisReportSpecSchema = z
  .object({
    executiveSummary: z.string().trim().min(1).max(8_000),
    metrics: z.array(AnalysisReportMetricSchema).max(20),
    sections: z
      .array(
        z
          .object({
            chart: AnalysisChartSchema.nullable(),
            citations: z.array(KnowledgeCitationSchema).max(100),
            id: StableBlockIdSchema,
            paragraphs: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20),
            title: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    title: z.string().trim().min(1).max(240),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.sections.forEach((section, index) => {
      if (ids.has(section.id)) {
        context.addIssue({
          code: "custom",
          message: "Report section IDs must be unique.",
          path: ["sections", index, "id"],
        });
      }
      ids.add(section.id);
    });
  });
export type AnalysisReportSpec = z.infer<typeof AnalysisReportSpecSchema>;
