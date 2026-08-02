import { z } from "zod";

export const KNOWLEDGE_SOURCE_MANIFEST_VERSION = "1.0.0" as const;
export const KNOWLEDGE_MAPPING_VERSION = "1.0.0" as const;
export const KNOWLEDGE_CORPUS_ID = "eduknow_knowledge_sources_v1" as const;
export const MAX_LECTURE_COUNT = 10_000 as const;

export const SourceRoleSchema = z.enum([
  "analysis_markdown",
  "transcript_json",
  "transcript_qa",
  "transcript_srt",
  "transcript_text",
]);
export type SourceRole = z.infer<typeof SourceRoleSchema>;

export const SOURCE_ROLES = SourceRoleSchema.options;

export const KnowledgeIndexTargetSchema = z.enum(["cases", "lectures", "transcript_segments"]);

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const RootIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);
const DocumentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .max(511);
const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value), {
    message: "paths must be relative",
  })
  .refine((value) => !value.includes("\\"), {
    message: "paths must use forward slashes",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "paths must not traverse parent directories",
  });

export const AnalysisSectionsSchema = z
  .object({
    actions: z.string().min(1),
    ai_cross_disciplinary: z.string().min(1),
    basics: z.string().min(1),
    cases: z.string().min(1),
    evidence: z.string().min(1),
    failures: z.string().min(1),
    quotes: z.string().min(1),
    summary: z.string().min(1),
    trends: z.string().min(1),
  })
  .strict();

export const SourcePolicySchema = z
  .object({
    allowed_index_targets: z.array(KnowledgeIndexTargetSchema),
    database_document_type: z.enum([
      "analysis_markdown",
      "attachment",
      "transcript_json",
      "transcript_srt",
    ]),
    index_policy: z.enum(["eligible", "privacy_review_required", "validation_only"]),
    privacy_classification: z.enum([
      "internal_anonymized_knowledge",
      "restricted_source_evidence",
      "restricted_source_metadata",
    ]),
    role: SourceRoleSchema,
  })
  .strict();

export const SourceRootSchema = z
  .object({
    lecture_year: z.number().int().min(2000).max(2100).nullable(),
    root_id: RootIdSchema,
    source_roles: z.array(SourceRoleSchema).min(1),
  })
  .strict()
  .refine((root) => new Set(root.source_roles).size === root.source_roles.length, {
    message: "source root roles must be unique",
    path: ["source_roles"],
  });

export const SourceFileSchema = z
  .object({
    bytes: z.number().int().positive(),
    content_sha256: Sha256Schema,
    logical_path: RelativePathSchema,
    mime_type: z.enum([
      "application/json",
      "application/x-subrip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/markdown",
      "text/plain",
    ]),
    relative_path: RelativePathSchema,
    role: SourceRoleSchema,
    root_id: RootIdSchema,
  })
  .strict();

export const TranscriptValidationSchema = z
  .object({
    changed_sentence_count: z.number().int().nonnegative(),
    duration_seconds: z.number().nonnegative(),
    sentence_count: z.number().int().positive(),
    srt_cue_count: z.number().int().positive(),
    text_line_count: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.sentence_count === value.srt_cue_count &&
      value.sentence_count === value.text_line_count,
    { message: "transcript representations must contain the same number of segments" },
  )
  .refine((value) => value.changed_sentence_count <= value.sentence_count, {
    message: "changed sentence count cannot exceed total sentence count",
  });

export const LectureSourceBundleSchema = z
  .object({
    analysis_sections: AnalysisSectionsSchema,
    bundle_hash: Sha256Schema,
    lecture_date: z.iso.date(),
    lecture_id: DocumentIdSchema,
    source_key: z.string().min(12).max(512),
    sources: z.array(SourceFileSchema).min(1).max(SOURCE_ROLES.length),
    title: z.string().trim().min(1).max(1_024),
    transcript_validation: TranscriptValidationSchema.nullable(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const roles = bundle.sources.map((source) => source.role);
    const uniqueRoles = new Set(roles);
    if (uniqueRoles.size !== roles.length) {
      context.addIssue({
        code: "custom",
        message: "a lecture bundle must not repeat a source role",
        path: ["sources"],
      });
    }
    if (!roles.includes("analysis_markdown")) {
      context.addIssue({
        code: "custom",
        message: "a lecture bundle must contain analysis_markdown",
        path: ["sources"],
      });
    }
    const nonAnalysisSources = bundle.sources.filter(
      (source) => source.role !== "analysis_markdown",
    );
    const singleTranscriptDocument =
      nonAnalysisSources.length === 1 &&
      nonAnalysisSources[0]?.role === "transcript_text" &&
      (nonAnalysisSources[0].mime_type === "text/markdown" ||
        nonAnalysisSources[0].mime_type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const hasVerifiedTranscriptPackage = nonAnalysisSources.length > 0 && !singleTranscriptDocument;
    if (hasVerifiedTranscriptPackage) {
      for (const role of SOURCE_ROLES) {
        if (roles.includes(role)) continue;
        context.addIssue({
          code: "custom",
          message: `missing source role: ${role}`,
          path: ["sources"],
        });
      }
    }
    if (
      (hasVerifiedTranscriptPackage && bundle.transcript_validation === null) ||
      (!hasVerifiedTranscriptPackage && bundle.transcript_validation !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "transcript_validation must match the presence of a complete verified transcript package",
        path: ["transcript_validation"],
      });
    }
    if (!bundle.source_key.startsWith(`${bundle.lecture_date}_`)) {
      context.addIssue({
        code: "custom",
        message: "source key must start with the lecture date",
        path: ["source_key"],
      });
    }
  });

export const IndexMappingSchema = z
  .object({
    primary_source_roles: z.array(SourceRoleSchema).min(1),
    required_gate: z.enum(["none", "privacy_review_and_anonymization"]),
    target_fields: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).min(1),
    target_index: KnowledgeIndexTargetSchema,
    validation_source_roles: z.array(SourceRoleSchema),
  })
  .strict();

export const ExcludedSourceFileSchema = z
  .object({
    reason: z.literal("aggregate_not_primary_source"),
    relative_path: RelativePathSchema,
    root_id: RootIdSchema,
  })
  .strict();

export const KnowledgeSourceManifestSchema = z
  .object({
    boundary_rules: z
      .object({
        manifest_contains_body_content: z.literal(false),
        manifest_purpose: z.literal("verified_inventory_import_entrypoint"),
        raw_embedded_paths_are_excluded: z.literal(true),
        source_files_read_only: z.literal(true),
        student_data_allowed: z.literal(false),
      })
      .strict(),
    builder_version: z.literal("0.1.0"),
    corpus_hash: Sha256Schema,
    corpus_id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/u)
      .max(128),
    excluded_files: z.array(ExcludedSourceFileSchema),
    expected_lecture_count: z.number().int().min(1).max(MAX_LECTURE_COUNT),
    index_mappings: z.array(IndexMappingSchema).length(3),
    lecture_count: z.number().int().min(1).max(MAX_LECTURE_COUNT),
    lectures: z.array(LectureSourceBundleSchema).min(1).max(MAX_LECTURE_COUNT),
    manifest_version: z.literal(KNOWLEDGE_SOURCE_MANIFEST_VERSION),
    mapping_version: z.literal(KNOWLEDGE_MAPPING_VERSION),
    source_policies: z.array(SourcePolicySchema).length(SOURCE_ROLES.length),
    source_roots: z.array(SourceRootSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const rootIds = manifest.source_roots.map((root) => root.root_id);
    const policyRoles = manifest.source_policies.map((policy) => policy.role);
    const sourceKeys = manifest.lectures.map((lecture) => lecture.source_key);
    const lectureIds = manifest.lectures.map((lecture) => lecture.lecture_id);
    const logicalPaths = manifest.lectures.flatMap((lecture) =>
      lecture.sources.map((source) => source.logical_path),
    );

    if (
      manifest.lecture_count !== manifest.lectures.length ||
      manifest.expected_lecture_count !== manifest.lectures.length
    ) {
      context.addIssue({
        code: "custom",
        message: "manifest lecture counts must match the lecture bundle count",
        path: ["lecture_count"],
      });
    }

    const uniqueChecks: ReadonlyArray<readonly [string, string[], PropertyKey]> = [
      ["source root IDs", rootIds, "source_roots"],
      ["source policy roles", policyRoles, "source_policies"],
      ["source keys", sourceKeys, "lectures"],
      ["lecture IDs", lectureIds, "lectures"],
      ["logical paths", logicalPaths, "lectures"],
    ];
    for (const [label, values, path] of uniqueChecks) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: `${label} must be unique`, path: [path] });
      }
    }

    const rootsById = new Map(manifest.source_roots.map((root) => [root.root_id, root]));
    for (const [lectureIndex, lecture] of manifest.lectures.entries()) {
      for (const [sourceIndex, source] of lecture.sources.entries()) {
        const root = rootsById.get(source.root_id);
        if (root === undefined) {
          context.addIssue({
            code: "custom",
            message: `unknown source root: ${source.root_id}`,
            path: ["lectures", lectureIndex, "sources", sourceIndex, "root_id"],
          });
        } else {
          if (!root.source_roles.includes(source.role)) {
            context.addIssue({
              code: "custom",
              message: `${source.role} is not declared by source root ${source.root_id}`,
              path: ["lectures", lectureIndex, "sources", sourceIndex, "role"],
            });
          }
          if (
            root.lecture_year !== null &&
            root.lecture_year !== Number(lecture.lecture_date.slice(0, 4))
          ) {
            context.addIssue({
              code: "custom",
              message: "source root year does not match lecture date",
              path: ["lectures", lectureIndex, "sources", sourceIndex, "root_id"],
            });
          }
        }
      }
    }
    for (const [excludedIndex, excluded] of manifest.excluded_files.entries()) {
      if (!rootsById.has(excluded.root_id)) {
        context.addIssue({
          code: "custom",
          message: `excluded file uses unknown source root ${excluded.root_id}`,
          path: ["excluded_files", excludedIndex, "root_id"],
        });
      }
    }
  });

export type AnalysisSections = z.infer<typeof AnalysisSectionsSchema>;
export type KnowledgeSourceManifest = z.infer<typeof KnowledgeSourceManifestSchema>;
export type LectureSourceBundle = z.infer<typeof LectureSourceBundleSchema>;
export type SourceFile = z.infer<typeof SourceFileSchema>;
