import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    accessLevel: accessLevelEnum("access_level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evidence_object_storage_version_unique").on(table.storageKey, table.version),
    check("evidence_object_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("evidence_object_version_check", sql`${table.version} > 0`),
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
    resultReference: jsonb("result_reference").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("background_job_idempotency_unique").on(table.idempotencyKey),
    index("background_job_status_created_idx").on(table.status, table.createdAt),
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
      sql`(${table.status} = 'queued' and ${table.startedAt} is null and ${table.completedAt} is null) or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null) or (${table.status} in ('succeeded', 'failed', 'canceled') and ${table.completedAt} is not null)`,
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
