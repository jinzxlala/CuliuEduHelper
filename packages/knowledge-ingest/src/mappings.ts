import { IndexMappingSchema, SourcePolicySchema, type SourceRole } from "./contracts.js";

export const SOURCE_POLICIES = SourcePolicySchema.array().parse([
  {
    allowed_index_targets: ["lectures", "cases"],
    database_document_type: "analysis_markdown",
    index_policy: "eligible",
    privacy_classification: "internal_anonymized_knowledge",
    role: "analysis_markdown",
  },
  {
    allowed_index_targets: ["transcript_segments"],
    database_document_type: "transcript_json",
    index_policy: "privacy_review_required",
    privacy_classification: "restricted_source_evidence",
    role: "transcript_json",
  },
  {
    allowed_index_targets: [],
    database_document_type: "attachment",
    index_policy: "validation_only",
    privacy_classification: "restricted_source_metadata",
    role: "transcript_qa",
  },
  {
    allowed_index_targets: [],
    database_document_type: "transcript_srt",
    index_policy: "validation_only",
    privacy_classification: "restricted_source_evidence",
    role: "transcript_srt",
  },
  {
    allowed_index_targets: [],
    database_document_type: "attachment",
    index_policy: "validation_only",
    privacy_classification: "restricted_source_evidence",
    role: "transcript_text",
  },
]);

export const INDEX_MAPPINGS = IndexMappingSchema.array().parse([
  {
    primary_source_roles: ["analysis_markdown"],
    required_gate: "none",
    target_fields: [
      "lecture_id",
      "title",
      "summary",
      "trend_text",
      "ai_cross_disciplinary_text",
      "failure_text",
      "date",
      "organization",
      "speakers",
      "schools",
      "majors",
      "source_path",
    ],
    target_index: "lectures",
    validation_source_roles: [],
  },
  {
    primary_source_roles: ["analysis_markdown"],
    required_gate: "none",
    target_fields: [
      "case_id",
      "lecture_id",
      "case_type",
      "curriculum_system",
      "academic_label",
      "background",
      "admission_result",
      "schools",
      "major",
      "research_methods",
      "activity_types",
      "ai_domains",
      "ai_depth",
      "confidence",
      "evidence_boundary",
      "timestamp_refs",
    ],
    target_index: "cases",
    validation_source_roles: ["transcript_json", "transcript_srt"],
  },
  {
    primary_source_roles: ["transcript_json"],
    required_gate: "privacy_review_and_anonymization",
    target_fields: [
      "segment_id",
      "lecture_id",
      "section",
      "text",
      "start_seconds",
      "end_seconds",
      "case_ids",
      "source_path",
    ],
    target_index: "transcript_segments",
    validation_source_roles: ["transcript_srt", "transcript_text", "transcript_qa"],
  },
]);

export function policyForRole(role: SourceRole): (typeof SOURCE_POLICIES)[number] {
  const policy = SOURCE_POLICIES.find((candidate) => candidate.role === role);
  if (policy === undefined) {
    throw new Error(`No source policy configured for role: ${role}`);
  }
  return policy;
}
