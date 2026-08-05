import { z } from "zod";

export const KNOWLEDGE_ANALYSIS_MAX_SOURCES = 100;
export const KNOWLEDGE_ANALYSIS_MAX_CONVERSATIONS = 50;
export const KNOWLEDGE_SMART_SEARCH_MAX_PLANS = 6;
export const KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES = 60;
export const KNOWLEDGE_SMART_SEARCH_MAX_RESULTS = 20;
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

export const SmartSearchFilterSchema = z
  .object({
    caseTypes: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    confidences: z
      .array(z.enum(["high", "medium", "low", "unknown"]))
      .max(4)
      .default([]),
    dateFrom: z.iso.date().nullable().default(null),
    dateTo: z.iso.date().nullable().default(null),
    majors: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    organizations: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    schools: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dateFrom !== null && value.dateTo !== null && value.dateFrom > value.dateTo) {
      context.addIssue({
        code: "custom",
        message: "Search dateFrom must not be after dateTo.",
        path: ["dateTo"],
      });
    }
  });

export const SmartSearchQueryPlanItemSchema = z
  .object({
    filters: SmartSearchFilterSchema,
    keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    matchingStrategy: z.enum(["last", "all"]),
    query: z.string().trim().min(1).max(500),
    target: z.enum(["lectures", "cases"]),
  })
  .strict()
  .superRefine((value, context) => {
    const hasCaseOnlyFilters =
      value.filters.caseTypes.length > 0 || value.filters.confidences.length > 0;
    const hasLectureOnlyFilters =
      value.filters.dateFrom !== null ||
      value.filters.dateTo !== null ||
      value.filters.organizations.length > 0;
    if (value.target === "lectures" && hasCaseOnlyFilters) {
      context.addIssue({
        code: "custom",
        message: "Lecture plans cannot use case-only filters.",
        path: ["filters"],
      });
    }
    if (value.target === "cases" && hasLectureOnlyFilters) {
      context.addIssue({
        code: "custom",
        message: "Case plans cannot use lecture-only filters.",
        path: ["filters"],
      });
    }
  });

export const SmartSearchQueryPlanSchema = z
  .object({
    interpretation: z.string().trim().min(1).max(2_000),
    queries: z.array(SmartSearchQueryPlanItemSchema).min(1).max(KNOWLEDGE_SMART_SEARCH_MAX_PLANS),
    round: z.number().int().min(1).max(KNOWLEDGE_SMART_SEARCH_MAX_ROUNDS),
  })
  .strict();
export type SmartSearchQueryPlan = z.infer<typeof SmartSearchQueryPlanSchema>;

export const SmartSearchCandidateReferenceSchema = KnowledgeSourceReferenceSchema.extend({
  matchedPlanIndexes: z.array(z.number().int().nonnegative()).min(1).max(6),
}).strict();

export const SmartSearchResultSchema = z
  .object({
    limitations: z.array(z.string().trim().min(1).max(500)).max(10),
    results: z
      .array(
        KnowledgeSourceReferenceSchema.extend({
          matchedTerms: z.array(z.string().trim().min(1).max(80)).max(20),
          rationale: z.string().trim().min(1).max(1_500),
        }).strict(),
      )
      .max(KNOWLEDGE_SMART_SEARCH_MAX_RESULTS),
    summary: z.string().trim().min(1).max(3_000),
  })
  .strict();
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
  .object({ title: z.string().trim().min(1).max(200) })
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
