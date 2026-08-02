import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["admin", "advisor", "auditor", "service"]);
export const dataDomainEnum = pgEnum("data_domain", ["knowledge", "student"]);
export const accessLevelEnum = pgEnum("access_level", ["internal", "sensitive", "restricted"]);
export const studentStatusEnum = pgEnum("student_status", ["active", "archived"]);
export const sourceDocumentTypeEnum = pgEnum("source_document_type", [
  "analysis_markdown",
  "transcript_srt",
  "transcript_json",
  "attachment",
  "export",
]);
export const factSourceTypeEnum = pgEnum("fact_source_type", [
  "advisor",
  "student",
  "parent",
  "evidence",
  "import",
]);
export const confirmationStatusEnum = pgEnum("confirmation_status", [
  "unconfirmed",
  "confirmed",
  "rejected",
  "superseded",
]);
export const locatorTypeEnum = pgEnum("locator_type", [
  "page",
  "paragraph",
  "character_range",
  "cell",
  "timestamp",
  "record_field",
]);
export const evidenceRelationEnum = pgEnum("evidence_relation", [
  "supports",
  "contradicts",
  "partially_supports",
]);
export const validationStatusEnum = pgEnum("validation_status", ["pending", "valid", "invalid"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "service"]);
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export const knowledgeImportStatusEnum = pgEnum("knowledge_import_status", [
  "staging",
  "publishing",
  "published",
  "failed",
]);
export const knowledgeImportAttemptStatusEnum = pgEnum("knowledge_import_attempt_status", [
  "running",
  "succeeded",
  "failed",
]);
export const knowledgeImportStageEnum = pgEnum("knowledge_import_stage", [
  "authorization",
  "validation",
  "storage",
  "database",
  "search",
  "finalize",
  "complete",
]);
export const knowledgeSourceRoleEnum = pgEnum("knowledge_source_role", [
  "analysis_markdown",
  "transcript_json",
  "transcript_qa",
  "transcript_srt",
  "transcript_text",
]);
export const profileStatusEnum = pgEnum("profile_status", [
  "draft",
  "in_review",
  "approved",
  "needs_review",
  "archived",
]);
export const profileReviewActionEnum = pgEnum("profile_review_action", [
  "revised",
  "submitted",
  "returned",
  "approved",
  "invalidated",
  "archived",
]);
export const profileClaimCategoryEnum = pgEnum("profile_claim_category", [
  "academic_foundation",
  "interest_thread",
  "experience_connections",
  "responsibility_impact",
  "interdisciplinary_ai_depth",
  "behavioral_evidence",
  "gaps_contradictions_risks",
  "one_sentence_label",
]);
export const informationNatureEnum = pgEnum("information_nature", [
  "fact",
  "inference",
  "missing",
  "advisor_judgment",
]);
export const confidenceLevelEnum = pgEnum("confidence_level", ["high", "medium", "low", "unknown"]);
export const courseCatalogStatusEnum = pgEnum("course_catalog_status", [
  "draft",
  "approved",
  "archived",
]);
export const courseDifficultyEnum = pgEnum("course_difficulty", [
  "foundation",
  "intermediate",
  "advanced",
]);
export const courseDeliveryModeEnum = pgEnum("course_delivery_mode", ["scheduled", "self_paced"]);
export const courseRuleTypeEnum = pgEnum("course_rule_type", [
  "prerequisite",
  "mutual_exclusion",
  "age_range",
  "time_conflict",
  "load_limit",
]);
export const courseRuleSeverityEnum = pgEnum("course_rule_severity", ["hard", "warning"]);
export const planStatusEnum = pgEnum("plan_status", [
  "draft",
  "in_review",
  "approved",
  "needs_review",
  "archived",
]);
export const planReviewActionEnum = pgEnum("plan_review_action", [
  "created",
  "submitted",
  "returned",
  "approved",
  "invalidated",
  "archived",
]);
export const planCourseDependencyKindEnum = pgEnum("plan_course_dependency_kind", [
  "selected",
  "in_progress",
  "rule_reference",
]);
export const planRuleOverrideStatusEnum = pgEnum("plan_rule_override_status", [
  "pending",
  "approved",
  "rejected",
]);

export const appUsers = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    role: userRoleEnum("role").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("app_user_email_unique").on(sql`lower(${table.email})`)],
);

export const students = pgTable(
  "student",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicCode: varchar("public_code", { length: 64 }).notNull(),
    privacyLevel: accessLevelEnum("privacy_level").notNull().default("sensitive"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    status: studentStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("student_public_code_unique").on(table.publicCode),
    index("student_owner_user_idx").on(table.ownerUserId),
  ],
);

export const studentAuthorizations = pgTable(
  "student_authorization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    allowedActions: text("allowed_actions").array().notNull(),
    maxAccessLevel: accessLevelEnum("max_access_level").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("student_authorization_user_student_unique").on(table.userId, table.studentId),
    check(
      "student_authorization_expiry_check",
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.validFrom}`,
    ),
    check("student_authorization_actions_check", sql`cardinality(${table.allowedActions}) > 0`),
  ],
);

export const authorizationContextSnapshots = pgTable(
  "authorization_context_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").references(() => students.id, { onDelete: "restrict" }),
    allowedActions: text("allowed_actions").array().notNull(),
    maxAccessLevel: accessLevelEnum("max_access_level").notNull(),
    contextHash: varchar("context_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("authorization_context_hash_unique").on(table.contextHash),
    check("authorization_context_hash_check", sql`${table.contextHash} ~ '^[0-9a-f]{64}$'`),
    check("authorization_context_actions_check", sql`cardinality(${table.allowedActions}) > 0`),
    check("authorization_context_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const sourceDocuments = pgTable(
  "source_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataDomain: dataDomainEnum("data_domain").notNull(),
    studentId: uuid("student_id").references(() => students.id, { onDelete: "restrict" }),
    sourcePath: text("source_path").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    documentType: sourceDocumentTypeEnum("document_type").notNull(),
    mimeType: text("mime_type").notNull(),
    version: integer("version").notNull().default(1),
    readOnly: boolean("read_only").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_document_domain_hash_version_unique").on(
      table.dataDomain,
      table.contentHash,
      table.version,
    ),
    uniqueIndex("source_document_id_domain_unique").on(table.id, table.dataDomain),
    check("source_document_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("source_document_version_check", sql`${table.version} > 0`),
    check("source_document_read_only_check", sql`${table.readOnly} = true`),
    check(
      "source_document_domain_student_check",
      sql`(${table.dataDomain} = 'knowledge' and ${table.studentId} is null) or (${table.dataDomain} = 'student' and ${table.studentId} is not null)`,
    ),
  ],
);

export const evidenceObjects = pgTable(
  "evidence_object",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataDomain: dataDomainEnum("data_domain").notNull(),
    studentId: uuid("student_id").references(() => students.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    storageKey: text("storage_key").notNull(),
    originalFileName: varchar("original_file_name", { length: 255 }).notNull().default("unknown"),
    mimeType: varchar("mime_type", { length: 255 }).notNull().default("application/octet-stream"),
    byteCount: integer("byte_count").notNull().default(0),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => evidenceObjects.id, {
      onDelete: "restrict",
    }),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    accessLevel: accessLevelEnum("access_level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evidence_object_storage_version_unique").on(table.storageKey, table.version),
    uniqueIndex("evidence_object_id_domain_unique").on(table.id, table.dataDomain),
    uniqueIndex("evidence_object_supersedes_unique")
      .on(table.supersedesId)
      .where(sql`${table.supersedesId} is not null`),
    index("evidence_object_student_created_idx").on(table.studentId, table.createdAt),
    check("evidence_object_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("evidence_object_version_check", sql`${table.version} > 0`),
    check("evidence_object_byte_count_check", sql`${table.byteCount} >= 0`),
    check(
      "evidence_object_not_self_superseding",
      sql`${table.supersedesId} is null or ${table.supersedesId} <> ${table.id}`,
    ),
    check(
      "evidence_object_storage_key_check",
      sql`(${table.dataDomain} = 'knowledge' and ${table.storageKey} like 'knowledge/%') or (${table.dataDomain} = 'student' and ${table.storageKey} like ('student/' || ${table.studentId}::text || '/%'))`,
    ),
    check(
      "evidence_object_domain_student_check",
      sql`(${table.dataDomain} = 'knowledge' and ${table.studentId} is null) or (${table.dataDomain} = 'student' and ${table.studentId} is not null)`,
    ),
  ],
);

export const evidenceInvalidations = pgTable(
  "evidence_invalidation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceObjectId: uuid("evidence_object_id")
      .notNull()
      .references(() => evidenceObjects.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 512 }).notNull(),
    invalidatedByUserId: uuid("invalidated_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evidence_invalidation_object_unique").on(table.evidenceObjectId),
    index("evidence_invalidation_created_idx").on(table.createdAt),
    check("evidence_invalidation_reason_check", sql`char_length(trim(${table.reason})) > 0`),
  ],
);

export const evidenceLocators = pgTable(
  "evidence_locator",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceObjectId: uuid("evidence_object_id")
      .notNull()
      .references(() => evidenceObjects.id, { onDelete: "restrict" }),
    locatorType: locatorTypeEnum("locator_type").notNull(),
    locator: jsonb("locator").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("evidence_locator_object_idx").on(table.evidenceObjectId)],
);

export const studentFacts = pgTable(
  "student_fact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    fieldKey: varchar("field_key", { length: 128 }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    accessLevel: accessLevelEnum("access_level").notNull().default("sensitive"),
    sourceType: factSourceTypeEnum("source_type").notNull(),
    confirmationStatus: confirmationStatusEnum("confirmation_status")
      .notNull()
      .default("unconfirmed"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => studentFacts.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("student_fact_student_field_idx").on(table.studentId, table.fieldKey),
    uniqueIndex("student_fact_supersedes_unique")
      .on(table.supersedesId)
      .where(sql`${table.supersedesId} is not null`),
    check(
      "student_fact_validity_check",
      sql`${table.validTo} is null or ${table.validTo} > ${table.validFrom}`,
    ),
    check(
      "student_fact_not_self_superseding",
      sql`${table.supersedesId} is null or ${table.supersedesId} <> ${table.id}`,
    ),
  ],
);

export const factEvidence = pgTable(
  "fact_evidence",
  {
    studentFactId: uuid("student_fact_id")
      .notNull()
      .references(() => studentFacts.id, { onDelete: "restrict" }),
    evidenceLocatorId: uuid("evidence_locator_id")
      .notNull()
      .references(() => evidenceLocators.id, { onDelete: "restrict" }),
    relation: evidenceRelationEnum("relation").notNull(),
    validationStatus: validationStatusEnum("validation_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.studentFactId, table.evidenceLocatorId] })],
);

export const profileInputSnapshots = pgTable(
  "profile_input_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    authorizationContextId: uuid("authorization_context_id")
      .notNull()
      .references(() => authorizationContextSnapshots.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    redactionVersion: varchar("redaction_version", { length: 64 }).notNull(),
    factCount: integer("fact_count").notNull(),
    evidenceLocatorCount: integer("evidence_locator_count").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("profile_input_snapshot_actor_hash_unique").on(
      table.studentId,
      table.createdByUserId,
      table.snapshotHash,
      table.redactionVersion,
    ),
    uniqueIndex("profile_input_snapshot_id_student_unique").on(table.id, table.studentId),
    index("profile_input_snapshot_student_created_idx").on(table.studentId, table.createdAt),
    check("profile_input_snapshot_hash_check", sql`${table.snapshotHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "profile_input_snapshot_counts_check",
      sql`${table.factCount} > 0 and ${table.evidenceLocatorCount} > 0`,
    ),
    check(
      "profile_input_snapshot_redaction_check",
      sql`char_length(trim(${table.redactionVersion})) > 0`,
    ),
  ],
);

export const profileInputSnapshotFacts = pgTable(
  "profile_input_snapshot_fact",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => profileInputSnapshots.id, { onDelete: "restrict" }),
    studentFactId: uuid("student_fact_id")
      .notNull()
      .references(() => studentFacts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.studentFactId] })],
);

export const profileInputSnapshotEvidence = pgTable(
  "profile_input_snapshot_evidence",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => profileInputSnapshots.id, { onDelete: "restrict" }),
    evidenceLocatorId: uuid("evidence_locator_id")
      .notNull()
      .references(() => evidenceLocators.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.evidenceLocatorId] })],
);

export const backgroundJobs = pgTable(
  "background_job",
  {
    id: uuid("id").primaryKey(),
    taskName: varchar("task_name", { length: 128 }).notNull(),
    authorizationContextId: uuid("authorization_context_id")
      .notNull()
      .references(() => authorizationContextSnapshots.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    resultReference: jsonb("result_reference").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("background_job_idempotency_unique").on(table.idempotencyKey),
    index("background_job_status_created_idx").on(table.status, table.createdAt),
    index("background_job_lease_idx").on(table.status, table.leaseExpiresAt),
    check(
      "background_job_attempts_check",
      sql`${table.attempts} >= 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check("background_job_max_attempts_check", sql`${table.maxAttempts} between 1 and 10`),
    check(
      "background_job_idempotency_key_check",
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]+$'`,
    ),
    check(
      "background_job_state_time_check",
      sql`(${table.status} = 'queued' and ${table.startedAt} is null and ${table.completedAt} is null and ${table.claimToken} is null and ${table.leaseExpiresAt} is null) or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.claimToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} in ('succeeded', 'failed', 'canceled') and ${table.completedAt} is not null and ${table.claimToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
  ],
);

export const modelTaskRuns = pgTable(
  "model_task_run",
  {
    id: uuid("id").primaryKey(),
    backgroundJobId: uuid("background_job_id")
      .notNull()
      .references(() => backgroundJobs.id, { onDelete: "restrict" }),
    taskType: varchar("task_type", { length: 64 }).notNull(),
    requestCorrelationId: uuid("request_correlation_id").notNull(),
    authorizationContextId: uuid("authorization_context_id")
      .notNull()
      .references(() => authorizationContextSnapshots.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    inputSnapshotId: uuid("input_snapshot_id").notNull(),
    inputSnapshotHash: varchar("input_snapshot_hash", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
    promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 64 }).notNull(),
    schemaHash: varchar("schema_hash", { length: 64 }).notNull(),
    redactionVersion: varchar("redaction_version", { length: 64 }).notNull(),
    gitCommitSha: varchar("git_commit_sha", { length: 40 }).notNull(),
    pricingVersion: varchar("pricing_version", { length: 64 }).notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    promptCacheHitTokens: integer("prompt_cache_hit_tokens"),
    promptCacheMissTokens: integer("prompt_cache_miss_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostMicrosCny: integer("estimated_cost_micros_cny"),
    providerRequestId: varchar("provider_request_id", { length: 256 }),
    outputHash: varchar("output_hash", { length: 64 }),
    errorCode: varchar("error_code", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("model_task_run_background_job_unique").on(table.backgroundJobId),
    foreignKey({
      columns: [table.inputSnapshotId, table.studentId],
      foreignColumns: [profileInputSnapshots.id, profileInputSnapshots.studentId],
      name: "model_task_run_snapshot_student_fk",
    }).onDelete("restrict"),
    index("model_task_run_student_created_idx").on(table.studentId, table.createdAt),
    check("model_task_run_type_check", sql`${table.taskType} = 'profile.draft'`),
    check(
      "model_task_run_hashes_check",
      sql`${table.inputSnapshotHash} ~ '^[0-9a-f]{64}$' and ${table.promptHash} ~ '^[0-9a-f]{64}$' and ${table.schemaHash} ~ '^[0-9a-f]{64}$' and (${table.outputHash} is null or ${table.outputHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check("model_task_run_git_sha_check", sql`${table.gitCommitSha} ~ '^[0-9a-f]{40}$'`),
    check("model_task_run_attempt_check", sql`${table.attemptCount} between 0 and 3`),
    check(
      "model_task_run_usage_check",
      sql`(${table.promptTokens} is null and ${table.promptCacheHitTokens} is null and ${table.promptCacheMissTokens} is null and ${table.completionTokens} is null and ${table.totalTokens} is null and ${table.estimatedCostMicrosCny} is null) or (${table.promptTokens} >= 0 and ${table.promptCacheHitTokens} >= 0 and ${table.promptCacheMissTokens} >= 0 and ${table.completionTokens} >= 0 and ${table.totalTokens} >= 0 and ${table.estimatedCostMicrosCny} >= 0 and ${table.promptCacheHitTokens} + ${table.promptCacheMissTokens} = ${table.promptTokens} and ${table.promptTokens} + ${table.completionTokens} = ${table.totalTokens})`,
    ),
    check(
      "model_task_run_state_check",
      sql`(${table.status} = 'queued' and ${table.startedAt} is null and ${table.completedAt} is null and ${table.outputHash} is null and ${table.errorCode} is null) or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.outputHash} is null and ${table.errorCode} is null) or (${table.status} = 'succeeded' and ${table.startedAt} is not null and ${table.completedAt} is not null and ${table.outputHash} is not null and ${table.errorCode} is null and ${table.totalTokens} is not null) or (${table.status} in ('failed', 'canceled') and ${table.startedAt} is not null and ${table.completedAt} is not null and ${table.outputHash} is null and ${table.errorCode} is not null)`,
    ),
  ],
);

export const profileVersions = pgTable(
  "profile_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: profileStatusEnum("status").notNull().default("draft"),
    inputSnapshotId: uuid("input_snapshot_id")
      .notNull()
      .references(() => profileInputSnapshots.id, { onDelete: "restrict" }),
    inputSnapshotHash: varchar("input_snapshot_hash", { length: 64 }).notNull(),
    modelTaskRunId: uuid("model_task_run_id")
      .notNull()
      .references(() => modelTaskRuns.id, { onDelete: "restrict" }),
    sourceProfileVersionId: uuid("source_profile_version_id").references(
      (): AnyPgColumn => profileVersions.id,
      { onDelete: "restrict" },
    ),
    questionsToConfirm: jsonb("questions_to_confirm")
      .$type<Array<{ question: string; relatedFieldKeys: string[] }>>()
      .notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    invalidationReason: varchar("invalidation_reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("profile_version_student_version_unique").on(table.studentId, table.version),
    uniqueIndex("profile_version_source_unique")
      .on(table.sourceProfileVersionId)
      .where(sql`${table.sourceProfileVersionId} is not null`),
    index("profile_version_model_task_idx").on(table.modelTaskRunId),
    index("profile_version_student_created_idx").on(table.studentId, table.createdAt),
    check("profile_version_version_check", sql`${table.version} > 0`),
    check("profile_version_hash_check", sql`${table.inputSnapshotHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "profile_version_state_check",
      sql`(${table.status} in ('draft', 'in_review') and ${table.approvedByUserId} is null and ${table.approvedAt} is null and ${table.invalidationReason} is null) or (${table.status} = 'approved' and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null and ${table.invalidationReason} is null) or (${table.status} = 'needs_review' and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null and ${table.invalidationReason} is not null) or (${table.status} = 'archived' and ((${table.approvedByUserId} is null and ${table.approvedAt} is null) or (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)) and ${table.invalidationReason} is not null)`,
    ),
  ],
);

export const profileReviewRecords = pgTable(
  "profile_review_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileVersionId: uuid("profile_version_id")
      .notNull()
      .references(() => profileVersions.id, { onDelete: "restrict" }),
    action: profileReviewActionEnum("action").notNull(),
    fromStatus: profileStatusEnum("from_status"),
    toStatus: profileStatusEnum("to_status").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    reason: varchar("reason", { length: 512 }),
    requestCorrelationId: uuid("request_correlation_id").notNull().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("profile_review_record_version_created_idx").on(table.profileVersionId, table.createdAt),
    check(
      "profile_review_record_actor_check",
      sql`(${table.actorType} = 'user' and ${table.actorUserId} is not null) or ${table.actorType} = 'service'`,
    ),
    check(
      "profile_review_record_reason_check",
      sql`(${table.action} in ('returned', 'invalidated', 'archived') and char_length(trim(${table.reason})) > 0) or (${table.action} not in ('returned', 'invalidated', 'archived'))`,
    ),
  ],
);

export const profileClaims = pgTable(
  "profile_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileVersionId: uuid("profile_version_id")
      .notNull()
      .references(() => profileVersions.id, { onDelete: "restrict" }),
    category: profileClaimCategoryEnum("category").notNull(),
    statement: text("statement").notNull(),
    informationNature: informationNatureEnum("information_nature").notNull(),
    confidence: confidenceLevelEnum("confidence").notNull(),
    evidenceCount: integer("evidence_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("profile_claim_version_category_idx").on(table.profileVersionId, table.category),
    check(
      "profile_claim_statement_check",
      sql`char_length(trim(${table.statement})) between 1 and 1200`,
    ),
    check(
      "profile_claim_evidence_count_check",
      sql`(${table.informationNature} = 'missing' and ${table.evidenceCount} = 0 and ${table.confidence} = 'unknown') or (${table.informationNature} <> 'missing' and ${table.evidenceCount} between 1 and 10 and ${table.confidence} <> 'unknown')`,
    ),
  ],
);

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    profileClaimId: uuid("profile_claim_id")
      .notNull()
      .references(() => profileClaims.id, { onDelete: "restrict" }),
    evidenceLocatorId: uuid("evidence_locator_id")
      .notNull()
      .references(() => evidenceLocators.id, { onDelete: "restrict" }),
    relation: evidenceRelationEnum("relation").notNull(),
    validationStatus: validationStatusEnum("validation_status").notNull().default("valid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.profileClaimId, table.evidenceLocatorId] })],
);

export const courses = pgTable(
  "course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 64 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("course_code_unique").on(sql`lower(${table.code})`),
    check("course_code_check", sql`${table.code} ~ '^[A-Z][A-Z0-9_-]{1,63}$'`),
  ],
);

export const courseVersions = pgTable(
  "course_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    sourceCourseVersionId: uuid("source_course_version_id").references(
      (): AnyPgColumn => courseVersions.id,
      { onDelete: "restrict" },
    ),
    status: courseCatalogStatusEnum("status").notNull().default("draft"),
    title: varchar("title", { length: 200 }).notNull(),
    stage: varchar("stage", { length: 128 }).notNull(),
    difficulty: courseDifficultyEnum("difficulty").notNull(),
    summary: text("summary").notNull(),
    objectives: jsonb("objectives").$type<string[]>().notNull(),
    capabilityTags: jsonb("capability_tags").$type<string[]>().notNull(),
    subjectTags: jsonb("subject_tags").$type<string[]>().notNull(),
    projectTypes: jsonb("project_types").$type<string[]>().notNull(),
    deliverables: jsonb("deliverables").$type<string[]>().notNull(),
    notSuitableConditions: jsonb("not_suitable_conditions").$type<string[]>().notNull(),
    deliveryMode: courseDeliveryModeEnum("delivery_mode").notNull(),
    termStartDate: date("term_start_date"),
    termEndDate: date("term_end_date"),
    durationWeeks: integer("duration_weeks").notNull(),
    totalInstructionMinutes: integer("total_instruction_minutes").notNull(),
    weeklyLoadMinutes: integer("weekly_load_minutes").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    invalidationReason: varchar("invalidation_reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("course_version_course_version_unique").on(table.courseId, table.version),
    uniqueIndex("course_version_source_unique")
      .on(table.sourceCourseVersionId)
      .where(sql`${table.sourceCourseVersionId} is not null`),
    uniqueIndex("course_version_current_approved_unique")
      .on(table.courseId)
      .where(sql`${table.status} = 'approved'`),
    index("course_version_status_created_idx").on(table.status, table.createdAt),
    check("course_version_version_check", sql`${table.version} > 0`),
    check(
      "course_version_text_check",
      sql`char_length(trim(${table.title})) between 1 and 200 and char_length(trim(${table.stage})) between 1 and 128 and char_length(trim(${table.summary})) between 1 and 4000`,
    ),
    check(
      "course_version_json_arrays_check",
      sql`jsonb_typeof(${table.objectives}) = 'array' and jsonb_array_length(${table.objectives}) between 1 and 30 and jsonb_typeof(${table.capabilityTags}) = 'array' and jsonb_array_length(${table.capabilityTags}) between 1 and 50 and jsonb_typeof(${table.subjectTags}) = 'array' and jsonb_array_length(${table.subjectTags}) between 1 and 30 and jsonb_typeof(${table.projectTypes}) = 'array' and jsonb_array_length(${table.projectTypes}) <= 30 and jsonb_typeof(${table.deliverables}) = 'array' and jsonb_array_length(${table.deliverables}) between 1 and 30 and jsonb_typeof(${table.notSuitableConditions}) = 'array' and jsonb_array_length(${table.notSuitableConditions}) <= 30`,
    ),
    check(
      "course_version_effort_check",
      sql`${table.durationWeeks} between 1 and 104 and ${table.totalInstructionMinutes} between 1 and 100000 and ${table.weeklyLoadMinutes} between 1 and 10080`,
    ),
    check(
      "course_version_term_check",
      sql`(${table.deliveryMode} = 'scheduled' and ${table.termStartDate} is not null and ${table.termEndDate} is not null and ${table.termEndDate} >= ${table.termStartDate}) or (${table.deliveryMode} = 'self_paced' and ((${table.termStartDate} is null and ${table.termEndDate} is null) or (${table.termStartDate} is not null and ${table.termEndDate} is not null and ${table.termEndDate} >= ${table.termStartDate})))`,
    ),
    check(
      "course_version_state_check",
      sql`(${table.status} = 'draft' and ${table.approvedByUserId} is null and ${table.approvedAt} is null and ${table.invalidationReason} is null) or (${table.status} = 'approved' and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null and ${table.invalidationReason} is null) or (${table.status} = 'archived' and ((${table.approvedByUserId} is null and ${table.approvedAt} is null) or (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)) and char_length(trim(${table.invalidationReason})) > 0)`,
    ),
  ],
);

export const courseScheduleSessions = pgTable(
  "course_schedule_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersions.id, { onDelete: "restrict" }),
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("course_schedule_session_unique").on(
      table.courseVersionId,
      table.weekday,
      table.startMinute,
      table.endMinute,
    ),
    index("course_schedule_version_idx").on(table.courseVersionId),
    check("course_schedule_weekday_check", sql`${table.weekday} between 1 and 7`),
    check(
      "course_schedule_minute_check",
      sql`${table.startMinute} between 0 and 1439 and ${table.endMinute} between 1 and 1440 and ${table.endMinute} > ${table.startMinute}`,
    ),
  ],
);

export const courseRules = pgTable(
  "course_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 128 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("course_rule_key_unique").on(sql`lower(${table.key})`),
    check("course_rule_key_check", sql`${table.key} ~ '^[a-z][a-z0-9_.-]{2,127}$'`),
  ],
);

export const courseRuleVersions = pgTable(
  "course_rule_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => courseRules.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    sourceRuleVersionId: uuid("source_rule_version_id").references(
      (): AnyPgColumn => courseRuleVersions.id,
      { onDelete: "restrict" },
    ),
    status: courseCatalogStatusEnum("status").notNull().default("draft"),
    ruleType: courseRuleTypeEnum("rule_type").notNull(),
    severity: courseRuleSeverityEnum("severity").notNull(),
    subjectCourseId: uuid("subject_course_id").references(() => courses.id, {
      onDelete: "restrict",
    }),
    relatedCourseId: uuid("related_course_id").references(() => courses.id, {
      onDelete: "restrict",
    }),
    minAge: integer("min_age"),
    maxAge: integer("max_age"),
    maxWeeklyMinutes: integer("max_weekly_minutes"),
    maxConcurrentCourses: integer("max_concurrent_courses"),
    message: varchar("message", { length: 500 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    invalidationReason: varchar("invalidation_reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("course_rule_version_rule_version_unique").on(table.ruleId, table.version),
    uniqueIndex("course_rule_version_source_unique")
      .on(table.sourceRuleVersionId)
      .where(sql`${table.sourceRuleVersionId} is not null`),
    uniqueIndex("course_rule_version_current_approved_unique")
      .on(table.ruleId)
      .where(sql`${table.status} = 'approved'`),
    index("course_rule_version_type_status_idx").on(table.ruleType, table.status),
    check("course_rule_version_number_check", sql`${table.version} > 0`),
    check(
      "course_rule_version_message_check",
      sql`char_length(trim(${table.message})) between 1 and 500`,
    ),
    check(
      "course_rule_version_payload_check",
      sql`(${table.ruleType} = 'prerequisite' and ${table.subjectCourseId} is not null and ${table.relatedCourseId} is not null and ${table.subjectCourseId} <> ${table.relatedCourseId} and ${table.minAge} is null and ${table.maxAge} is null and ${table.maxWeeklyMinutes} is null and ${table.maxConcurrentCourses} is null) or (${table.ruleType} = 'mutual_exclusion' and ${table.subjectCourseId} is not null and ${table.relatedCourseId} is not null and ${table.subjectCourseId}::text < ${table.relatedCourseId}::text and ${table.minAge} is null and ${table.maxAge} is null and ${table.maxWeeklyMinutes} is null and ${table.maxConcurrentCourses} is null) or (${table.ruleType} = 'age_range' and ${table.subjectCourseId} is not null and ${table.relatedCourseId} is null and (${table.minAge} is not null or ${table.maxAge} is not null) and (${table.minAge} is null or ${table.minAge} between 3 and 100) and (${table.maxAge} is null or ${table.maxAge} between 3 and 100) and (${table.minAge} is null or ${table.maxAge} is null or ${table.maxAge} >= ${table.minAge}) and ${table.maxWeeklyMinutes} is null and ${table.maxConcurrentCourses} is null) or (${table.ruleType} = 'time_conflict' and ${table.subjectCourseId} is null and ${table.relatedCourseId} is null and ${table.minAge} is null and ${table.maxAge} is null and ${table.maxWeeklyMinutes} is null and ${table.maxConcurrentCourses} is null) or (${table.ruleType} = 'load_limit' and ${table.subjectCourseId} is null and ${table.relatedCourseId} is null and ${table.minAge} is null and ${table.maxAge} is null and (${table.maxWeeklyMinutes} is not null or ${table.maxConcurrentCourses} is not null) and (${table.maxWeeklyMinutes} is null or ${table.maxWeeklyMinutes} between 1 and 10080) and (${table.maxConcurrentCourses} is null or ${table.maxConcurrentCourses} between 1 and 50))`,
    ),
    check(
      "course_rule_version_state_check",
      sql`(${table.status} = 'draft' and ${table.approvedByUserId} is null and ${table.approvedAt} is null and ${table.invalidationReason} is null) or (${table.status} = 'approved' and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null and ${table.invalidationReason} is null) or (${table.status} = 'archived' and ((${table.approvedByUserId} is null and ${table.approvedAt} is null) or (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)) and char_length(trim(${table.invalidationReason})) > 0)`,
    ),
  ],
);

export const planVersions = pgTable(
  "plan_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    sourcePlanVersionId: uuid("source_plan_version_id").references(
      (): AnyPgColumn => planVersions.id,
      { onDelete: "restrict" },
    ),
    status: planStatusEnum("status").notNull().default("draft"),
    profileVersionId: uuid("profile_version_id")
      .notNull()
      .references(() => profileVersions.id, { onDelete: "restrict" }),
    studentInput: jsonb("student_input").$type<Record<string, unknown>>().notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    catalogSnapshot: jsonb("catalog_snapshot").$type<Record<string, unknown>>().notNull(),
    evaluation: jsonb("evaluation").$type<Record<string, unknown>>().notNull(),
    catalogSnapshotHash: varchar("catalog_snapshot_hash", { length: 64 }).notNull(),
    inputSnapshotHash: varchar("input_snapshot_hash", { length: 64 }).notNull(),
    reviewDueDate: date("review_due_date").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    invalidationReason: varchar("invalidation_reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("plan_version_student_version_unique").on(table.studentId, table.version),
    uniqueIndex("plan_version_source_unique")
      .on(table.sourcePlanVersionId)
      .where(sql`${table.sourcePlanVersionId} is not null`),
    uniqueIndex("plan_version_current_approved_unique")
      .on(table.studentId)
      .where(sql`${table.status} = 'approved'`),
    index("plan_version_student_created_idx").on(table.studentId, table.createdAt),
    index("plan_version_profile_idx").on(table.profileVersionId),
    check("plan_version_number_check", sql`${table.version} > 0`),
    check(
      "plan_version_hashes_check",
      sql`${table.catalogSnapshotHash} ~ '^[0-9a-f]{64}$' and ${table.inputSnapshotHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "plan_version_json_check",
      sql`jsonb_typeof(${table.studentInput}) = 'object' and jsonb_typeof(${table.content}) = 'object' and jsonb_typeof(${table.catalogSnapshot}) = 'object' and jsonb_typeof(${table.evaluation}) = 'object'`,
    ),
    check(
      "plan_version_state_check",
      sql`(${table.status} in ('draft', 'in_review') and ${table.approvedByUserId} is null and ${table.approvedAt} is null and ${table.invalidationReason} is null) or (${table.status} = 'approved' and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null and ${table.invalidationReason} is null) or (${table.status} = 'needs_review' and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null and char_length(trim(${table.invalidationReason})) > 0) or (${table.status} = 'archived' and ((${table.approvedByUserId} is null and ${table.approvedAt} is null) or (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)) and char_length(trim(${table.invalidationReason})) > 0)`,
    ),
  ],
);

export const planCourseDependencies = pgTable(
  "plan_course_dependency",
  {
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersions.id, { onDelete: "restrict" }),
    dependencyKind: planCourseDependencyKindEnum("dependency_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.planVersionId, table.courseVersionId] }),
    index("plan_course_dependency_course_idx").on(table.courseVersionId),
  ],
);

export const planRuleDependencies = pgTable(
  "plan_rule_dependency",
  {
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    ruleVersionId: uuid("rule_version_id")
      .notNull()
      .references(() => courseRuleVersions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.planVersionId, table.ruleVersionId] }),
    index("plan_rule_dependency_rule_idx").on(table.ruleVersionId),
  ],
);

export const planReviewRecords = pgTable(
  "plan_review_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    action: planReviewActionEnum("action").notNull(),
    fromStatus: planStatusEnum("from_status"),
    toStatus: planStatusEnum("to_status").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    reason: varchar("reason", { length: 512 }),
    requestCorrelationId: uuid("request_correlation_id").notNull().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("plan_review_record_version_created_idx").on(table.planVersionId, table.createdAt),
    check(
      "plan_review_record_actor_check",
      sql`(${table.actorType} = 'user' and ${table.actorUserId} is not null) or (${table.actorType} = 'service' and ${table.actorUserId} is null)`,
    ),
    check(
      "plan_review_record_reason_check",
      sql`(${table.action} in ('returned', 'invalidated', 'archived') and char_length(trim(${table.reason})) > 0) or (${table.action} not in ('returned', 'invalidated', 'archived'))`,
    ),
  ],
);

export const planRuleOverrides = pgTable(
  "plan_rule_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    ruleVersionId: uuid("rule_version_id")
      .notNull()
      .references(() => courseRuleVersions.id, { onDelete: "restrict" }),
    scopeKey: varchar("scope_key", { length: 64 }).notNull(),
    violationKey: varchar("violation_key", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    status: planRuleOverrideStatusEnum("status").notNull().default("pending"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    decidedByUserId: uuid("decided_by_user_id").references(() => appUsers.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: varchar("decision_reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("plan_rule_override_active_unique")
      .on(table.planVersionId, table.violationKey)
      .where(sql`${table.status} in ('pending', 'approved')`),
    index("plan_rule_override_plan_created_idx").on(table.planVersionId, table.createdAt),
    check(
      "plan_rule_override_key_check",
      sql`${table.violationKey} ~ '^[0-9a-f]{64}$' and ${table.scopeKey} ~ '^(short_term|route_[ab]_phase_[1-9][0-9]*)$'`,
    ),
    check(
      "plan_rule_override_reason_check",
      sql`char_length(trim(${table.reason})) between 1 and 1000`,
    ),
    check(
      "plan_rule_override_state_check",
      sql`(${table.status} = 'pending' and ${table.decidedByUserId} is null and ${table.decidedAt} is null and ${table.decisionReason} is null) or (${table.status} = 'approved' and ${table.decidedByUserId} is not null and ${table.decidedAt} is not null and ${table.decisionReason} is null) or (${table.status} = 'rejected' and ${table.decidedByUserId} is not null and ${table.decidedAt} is not null and char_length(trim(${table.decisionReason})) > 0)`,
    ),
  ],
);

export const knowledgeImportBatches = pgTable(
  "knowledge_import_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: varchar("corpus_id", { length: 128 }).notNull(),
    corpusHash: varchar("corpus_hash", { length: 64 }).notNull(),
    manifestVersion: varchar("manifest_version", { length: 32 }).notNull(),
    mappingVersion: varchar("mapping_version", { length: 32 }).notNull(),
    status: knowledgeImportStatusEnum("status").notNull().default("staging"),
    isCurrent: boolean("is_current").notNull().default(false),
    expectedLectureCount: integer("expected_lecture_count").notNull(),
    lectureCount: integer("lecture_count").notNull().default(0),
    caseCount: integer("case_count").notNull().default(0),
    transcriptSegmentCount: integer("transcript_segment_count").notNull().default(0),
    transcriptPublicationApproved: boolean("transcript_publication_approved")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("knowledge_import_batch_identity_unique").on(
      table.corpusId,
      table.corpusHash,
      table.mappingVersion,
      table.manifestVersion,
    ),
    uniqueIndex("knowledge_import_batch_current_unique")
      .on(table.isCurrent)
      .where(sql`${table.isCurrent} = true`),
    index("knowledge_import_batch_status_created_idx").on(table.status, table.createdAt),
    check("knowledge_import_batch_hash_check", sql`${table.corpusHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "knowledge_import_batch_counts_check",
      sql`${table.expectedLectureCount} > 0 and ${table.lectureCount} >= 0 and ${table.caseCount} >= 0 and ${table.transcriptSegmentCount} >= 0`,
    ),
    check(
      "knowledge_import_batch_privacy_gate_check",
      sql`${table.transcriptPublicationApproved} = false and ${table.transcriptSegmentCount} = 0`,
    ),
    check(
      "knowledge_import_batch_state_check",
      sql`(${table.status} = 'published' and ${table.publishedAt} is not null) or (${table.status} <> 'published' and ${table.publishedAt} is null)`,
    ),
    check(
      "knowledge_import_batch_current_check",
      sql`${table.isCurrent} = false or ${table.status} = 'published'`,
    ),
  ],
);

export const knowledgeImportAttempts = pgTable(
  "knowledge_import_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeImportBatches.id, { onDelete: "restrict" }),
    backgroundJobId: uuid("background_job_id").references(() => backgroundJobs.id, {
      onDelete: "restrict",
    }),
    attemptNumber: integer("attempt_number").notNull(),
    status: knowledgeImportAttemptStatusEnum("status").notNull().default("running"),
    stage: knowledgeImportStageEnum("stage").notNull().default("validation"),
    errorCode: varchar("error_code", { length: 128 }),
    errorSourceKey: text("error_source_key"),
    errorSourceRole: knowledgeSourceRoleEnum("error_source_role"),
    failureSummary: text("failure_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("knowledge_import_attempt_batch_number_unique").on(
      table.batchId,
      table.attemptNumber,
    ),
    index("knowledge_import_attempt_batch_started_idx").on(table.batchId, table.startedAt),
    check("knowledge_import_attempt_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "knowledge_import_attempt_state_check",
      sql`(${table.status} = 'running' and ${table.completedAt} is null and ${table.errorCode} is null and ${table.failureSummary} is null) or (${table.status} = 'succeeded' and ${table.completedAt} is not null and ${table.errorCode} is null and ${table.failureSummary} is null and ${table.stage} = 'complete') or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.errorCode} is not null and ${table.failureSummary} is not null)`,
    ),
    check(
      "knowledge_import_attempt_failure_summary_check",
      sql`${table.failureSummary} is null or char_length(${table.failureSummary}) <= 2048`,
    ),
  ],
);

export const knowledgeImportSources = pgTable(
  "knowledge_import_source",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeImportBatches.id, { onDelete: "cascade" }),
    dataDomain: dataDomainEnum("data_domain").notNull().default("knowledge"),
    lectureId: varchar("lecture_id", { length: 511 }).notNull(),
    sourceRole: knowledgeSourceRoleEnum("source_role").notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    evidenceObjectId: uuid("evidence_object_id").notNull(),
    sourceKey: text("source_key").notNull(),
    logicalPath: text("logical_path").notNull(),
    rootId: varchar("root_id", { length: 128 }).notNull(),
    byteCount: integer("byte_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.lectureId, table.sourceRole] }),
    foreignKey({
      columns: [table.sourceDocumentId, table.dataDomain],
      foreignColumns: [sourceDocuments.id, sourceDocuments.dataDomain],
      name: "knowledge_import_source_document_domain_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.evidenceObjectId, table.dataDomain],
      foreignColumns: [evidenceObjects.id, evidenceObjects.dataDomain],
      name: "knowledge_import_source_evidence_domain_fk",
    }).onDelete("restrict"),
    index("knowledge_import_source_document_idx").on(table.sourceDocumentId),
    check("knowledge_import_source_domain_check", sql`${table.dataDomain} = 'knowledge'`),
    check("knowledge_import_source_bytes_check", sql`${table.byteCount} > 0`),
    check(
      "knowledge_import_source_logical_path_check",
      sql`${table.logicalPath} like 'knowledge/%' and ${table.logicalPath} not like '%..%'`,
    ),
  ],
);

export const knowledgeLectureVersions = pgTable(
  "knowledge_lecture_version",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeImportBatches.id, { onDelete: "cascade" }),
    dataDomain: dataDomainEnum("data_domain").notNull().default("knowledge"),
    lectureId: varchar("lecture_id", { length: 511 }).notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    trendText: text("trend_text").notNull(),
    aiCrossDisciplinaryText: text("ai_cross_disciplinary_text").notNull(),
    failureText: text("failure_text").notNull(),
    lectureDate: date("lecture_date", { mode: "string" }),
    organization: text("organization"),
    speakers: text("speakers").array().notNull(),
    schools: text("schools").array().notNull(),
    majors: text("majors").array().notNull(),
    sourcePath: text("source_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.lectureId] }),
    foreignKey({
      columns: [table.sourceDocumentId, table.dataDomain],
      foreignColumns: [sourceDocuments.id, sourceDocuments.dataDomain],
      name: "knowledge_lecture_version_source_domain_fk",
    }).onDelete("restrict"),
    index("knowledge_lecture_version_source_idx").on(table.sourceDocumentId),
    check("knowledge_lecture_version_domain_check", sql`${table.dataDomain} = 'knowledge'`),
    check("knowledge_lecture_version_title_check", sql`char_length(${table.title}) > 0`),
    check(
      "knowledge_lecture_version_source_path_check",
      sql`${table.sourcePath} like 'knowledge/analysis/%' and ${table.sourcePath} not like '%..%'`,
    ),
  ],
);

export const knowledgeCaseVersions = pgTable(
  "knowledge_case_version",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeImportBatches.id, { onDelete: "cascade" }),
    dataDomain: dataDomainEnum("data_domain").notNull().default("knowledge"),
    caseId: varchar("case_id", { length: 511 }).notNull(),
    lectureId: varchar("lecture_id", { length: 511 }).notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    caseType: text("case_type").notNull(),
    curriculumSystem: text("curriculum_system"),
    academicLabel: text("academic_label").notNull(),
    background: text("background").notNull(),
    admissionResult: text("admission_result").notNull(),
    schools: text("schools").array().notNull(),
    major: text("major"),
    researchMethods: text("research_methods").array().notNull(),
    activityTypes: text("activity_types").array().notNull(),
    aiDomains: text("ai_domains").array().notNull(),
    aiDepth: text("ai_depth"),
    confidence: varchar("confidence", { length: 16 }).notNull(),
    evidenceBoundary: text("evidence_boundary").notNull(),
    timestampRefs: jsonb("timestamp_refs")
      .$type<
        Array<{
          end_seconds: number;
          segment_id: string;
          source_path: string;
          start_seconds: number;
        }>
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.caseId] }),
    foreignKey({
      columns: [table.batchId, table.lectureId],
      foreignColumns: [knowledgeLectureVersions.batchId, knowledgeLectureVersions.lectureId],
      name: "knowledge_case_version_lecture_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceDocumentId, table.dataDomain],
      foreignColumns: [sourceDocuments.id, sourceDocuments.dataDomain],
      name: "knowledge_case_version_source_domain_fk",
    }).onDelete("restrict"),
    index("knowledge_case_version_lecture_idx").on(table.batchId, table.lectureId),
    index("knowledge_case_version_source_idx").on(table.sourceDocumentId),
    check("knowledge_case_version_domain_check", sql`${table.dataDomain} = 'knowledge'`),
    check("knowledge_case_version_type_check", sql`char_length(${table.caseType}) > 0`),
    check(
      "knowledge_case_version_confidence_check",
      sql`${table.confidence} in ('high', 'medium', 'low', 'unknown')`,
    ),
    check(
      "knowledge_case_version_timestamp_gate_check",
      sql`jsonb_array_length(${table.timestampRefs}) = 0`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => appUsers.id, { onDelete: "restrict" }),
    action: varchar("action", { length: 128 }).notNull(),
    studentId: uuid("student_id").references(() => students.id, { onDelete: "restrict" }),
    objectType: varchar("object_type", { length: 128 }).notNull(),
    objectId: text("object_id").notNull(),
    result: varchar("result", { length: 64 }).notNull(),
    requestCorrelationId: uuid("request_correlation_id").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_event_student_created_idx").on(table.studentId, table.createdAt),
    index("audit_event_request_idx").on(table.requestCorrelationId),
    check(
      "audit_event_actor_check",
      sql`(${table.actorType} = 'user' and ${table.actorUserId} is not null) or (${table.actorType} = 'service')`,
    ),
  ],
);
