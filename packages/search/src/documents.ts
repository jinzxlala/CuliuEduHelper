import { z } from "zod";

export const MeilisearchDocumentIdSchema = z
  .string()
  .min(1)
  .max(511)
  .regex(
    /^[A-Za-z0-9_-]+$/u,
    "document IDs may contain only letters, digits, hyphens, and underscores",
  );

const OptionalTextSchema = z.string().trim().max(100_000);
const RequiredTextSchema = OptionalTextSchema.pipe(z.string().min(1));
const FacetValueSchema = z.string().trim().min(1).max(512);
const FacetValuesSchema = z
  .array(FacetValueSchema)
  .max(256)
  .refine(
    (values) => new Set(values).size === values.length,
    "facet values must not contain duplicates",
  );
const DocumentIdsSchema = z
  .array(MeilisearchDocumentIdSchema)
  .max(256)
  .refine(
    (values) => new Set(values).size === values.length,
    "document references must not contain duplicates",
  );

export const IsoDateSchema = z.iso.date();

export const SourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value), {
    message: "source paths must be logical relative paths",
  })
  .refine((value) => !value.includes("\\"), {
    message: "source paths must use forward slashes",
  })
  .refine((value) => !value.split(/[\\/]/u).includes(".."), {
    message: "source paths must not traverse parent directories",
  });

export const TimestampReferenceSchema = z
  .object({
    end_seconds: z.number().nonnegative(),
    segment_id: MeilisearchDocumentIdSchema,
    source_path: SourcePathSchema,
    start_seconds: z.number().nonnegative(),
  })
  .strict()
  .refine((value) => value.end_seconds >= value.start_seconds, {
    message: "timestamp end must be greater than or equal to its start",
    path: ["end_seconds"],
  });

export const LectureDocumentSchema = z
  .object({
    ai_cross_disciplinary_text: OptionalTextSchema,
    date: IsoDateSchema.nullable(),
    failure_text: OptionalTextSchema,
    lecture_id: MeilisearchDocumentIdSchema,
    majors: FacetValuesSchema,
    organization: FacetValueSchema.nullable(),
    schools: FacetValuesSchema,
    source_path: SourcePathSchema,
    speakers: FacetValuesSchema,
    summary: OptionalTextSchema,
    title: RequiredTextSchema,
    trend_text: OptionalTextSchema,
  })
  .strict();

export type LectureDocument = z.infer<typeof LectureDocumentSchema>;

export const CaseConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);

export const CaseProjectSchema = z
  .object({
    actions: FacetValuesSchema,
    impact: OptionalTextSchema,
    methods: FacetValuesSchema,
    name: RequiredTextSchema.pipe(z.string().max(512)),
    outputs: FacetValuesSchema,
    role: OptionalTextSchema.pipe(z.string().max(2_000)),
  })
  .strict();

export const CaseEvidencePointSchema = z
  .object({
    claim: RequiredTextSchema.pipe(z.string().max(4_000)),
    confidence: CaseConfidenceSchema,
    evidence: RequiredTextSchema.pipe(z.string().max(4_000)),
    source_locator: OptionalTextSchema.pipe(z.string().max(512)),
  })
  .strict();

export const CaseDocumentSchema = z
  .object({
    academic_label: OptionalTextSchema,
    activity_types: FacetValuesSchema,
    admission_result: OptionalTextSchema,
    ai_depth: FacetValueSchema.nullable(),
    ai_domains: FacetValuesSchema,
    background: OptionalTextSchema,
    case_id: MeilisearchDocumentIdSchema,
    case_type: FacetValueSchema,
    confidence: CaseConfidenceSchema,
    core_projects: z.array(CaseProjectSchema).max(12).default([]),
    core_strengths: FacetValuesSchema.default([]),
    curriculum_system: FacetValueSchema.nullable(),
    development_path: z.array(OptionalTextSchema).max(20).default([]),
    evidence_boundary: OptionalTextSchema,
    evidence_points: z.array(CaseEvidencePointSchema).max(30).default([]),
    advisor_insights: z.array(OptionalTextSchema).max(20).default([]),
    application_strategy: z.array(OptionalTextSchema).max(20).default([]),
    interpretations: z.array(OptionalTextSchema).max(20).default([]),
    lecture_id: MeilisearchDocumentIdSchema,
    major: FacetValueSchema.nullable(),
    missing_information: z.array(OptionalTextSchema).max(20).default([]),
    profile_summary: OptionalTextSchema.default(""),
    research_methods: FacetValuesSchema,
    schools: FacetValuesSchema,
    source_date: IsoDateSchema.nullable(),
    timestamp_refs: z.array(TimestampReferenceSchema).max(256),
    verified_facts: z.array(OptionalTextSchema).max(30).default([]),
  })
  .strict();

export type CaseDocument = z.infer<typeof CaseDocumentSchema>;

export const TranscriptSegmentDocumentSchema = z
  .object({
    case_ids: DocumentIdsSchema,
    end_seconds: z.number().nonnegative(),
    lecture_id: MeilisearchDocumentIdSchema,
    section: FacetValueSchema.nullable(),
    segment_id: MeilisearchDocumentIdSchema,
    source_path: SourcePathSchema,
    start_seconds: z.number().nonnegative(),
    text: RequiredTextSchema,
  })
  .strict()
  .refine((value) => value.end_seconds >= value.start_seconds, {
    message: "segment end must be greater than or equal to its start",
    path: ["end_seconds"],
  });

export type TranscriptSegmentDocument = z.infer<typeof TranscriptSegmentDocumentSchema>;

export const EvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lecture"), lecture_id: MeilisearchDocumentIdSchema }).strict(),
  z.object({ kind: z.literal("case"), case_id: MeilisearchDocumentIdSchema }).strict(),
  z
    .object({ kind: z.literal("transcript_segment"), segment_id: MeilisearchDocumentIdSchema })
    .strict(),
]);

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type EvidenceDocument = LectureDocument | CaseDocument | TranscriptSegmentDocument;

export const KnowledgeDocumentSetSchema = z
  .object({
    cases: z.array(CaseDocumentSchema),
    lectures: z.array(LectureDocumentSchema),
    transcriptSegments: z.array(TranscriptSegmentDocumentSchema),
  })
  .strict();

export type KnowledgeDocumentSet = z.infer<typeof KnowledgeDocumentSetSchema>;
