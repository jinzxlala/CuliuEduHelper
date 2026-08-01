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
