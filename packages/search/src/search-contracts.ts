import { z } from "zod";

const QuerySchema = z.string().trim().max(500).default("");
export const SearchMatchingStrategySchema = z.enum(["last", "all"]);
const PaginationSchema = {
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().nonnegative().max(10_000).default(0),
} as const;
const OptionalFacetFilterSchema = z.array(z.string().trim().min(1).max(512)).max(50).optional();

export const KnowledgeHybridSearchSchema = z
  .object({
    embedder: z.literal("knowledge_zh_v1"),
    semanticRatio: z.number().min(0).max(1),
  })
  .strict();

export const LectureFacetSchema = z.enum(["date", "organization", "speakers", "schools", "majors"]);

export const LectureSearchInputSchema = z
  .object({
    facets: z.array(LectureFacetSchema).max(5).default([]),
    filters: z
      .object({
        dateFrom: z.iso.date().optional(),
        dateTo: z.iso.date().optional(),
        majors: OptionalFacetFilterSchema,
        organizations: OptionalFacetFilterSchema,
        schools: OptionalFacetFilterSchema,
        speakers: OptionalFacetFilterSchema,
      })
      .strict()
      .default({}),
    ...PaginationSchema,
    hybrid: KnowledgeHybridSearchSchema.optional(),
    matchingStrategy: SearchMatchingStrategySchema.default("last"),
    query: QuerySchema,
    sort: z.enum(["date:asc", "date:desc", "title:asc", "title:desc"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.filters.dateFrom === undefined ||
      value.filters.dateTo === undefined ||
      value.filters.dateFrom <= value.filters.dateTo,
    { message: "dateFrom must not be later than dateTo", path: ["filters", "dateFrom"] },
  );

export type LectureSearchInput = z.input<typeof LectureSearchInputSchema>;

export const CaseFacetSchema = z.enum([
  "lecture_id",
  "case_type",
  "curriculum_system",
  "schools",
  "major",
  "research_methods",
  "activity_types",
  "ai_domains",
  "ai_depth",
  "confidence",
]);

export const CaseSearchInputSchema = z
  .object({
    facets: z.array(CaseFacetSchema).max(10).default([]),
    filters: z
      .object({
        activityTypes: OptionalFacetFilterSchema,
        aiDepth: OptionalFacetFilterSchema,
        aiDomains: OptionalFacetFilterSchema,
        caseTypes: OptionalFacetFilterSchema,
        confidence: z
          .array(z.enum(["high", "medium", "low", "unknown"]))
          .max(4)
          .optional(),
        curriculumSystems: OptionalFacetFilterSchema,
        lectureIds: OptionalFacetFilterSchema,
        majors: OptionalFacetFilterSchema,
        researchMethods: OptionalFacetFilterSchema,
        schools: OptionalFacetFilterSchema,
      })
      .strict()
      .default({}),
    ...PaginationSchema,
    hybrid: KnowledgeHybridSearchSchema.optional(),
    matchingStrategy: SearchMatchingStrategySchema.default("last"),
    query: QuerySchema,
  })
  .strict();

export type CaseSearchInput = z.input<typeof CaseSearchInputSchema>;

export const TranscriptFacetSchema = z.enum(["lecture_id", "section", "case_ids"]);

export const TranscriptSearchInputSchema = z
  .object({
    facets: z.array(TranscriptFacetSchema).max(3).default([]),
    filters: z
      .object({
        caseIds: OptionalFacetFilterSchema,
        lectureIds: OptionalFacetFilterSchema,
        sections: OptionalFacetFilterSchema,
      })
      .strict()
      .default({}),
    ...PaginationSchema,
    matchingStrategy: SearchMatchingStrategySchema.default("last"),
    query: QuerySchema,
    sort: z
      .enum(["start_seconds:asc", "start_seconds:desc", "end_seconds:asc", "end_seconds:desc"])
      .optional(),
  })
  .strict();

export type TranscriptSearchInput = z.input<typeof TranscriptSearchInputSchema>;

export interface SearchHit<TDocument> {
  document: TDocument;
  formatted: Partial<Record<keyof TDocument, unknown>>;
}

export interface SearchPage<TDocument> {
  estimatedTotalHits: number;
  facetDistribution: Record<string, Record<string, number>>;
  hits: SearchHit<TDocument>[];
  limit: number;
  offset: number;
  processingTimeMs: number;
  query: string;
}
