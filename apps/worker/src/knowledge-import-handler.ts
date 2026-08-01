import { randomUUID } from "node:crypto";

import type { DatabaseClient, DatabaseConnection } from "@culiu/database";
import {
  describeImportFailure,
  KnowledgeImportError,
  type KnowledgeImporter,
} from "@culiu/knowledge-ingest";
import type { KnowledgeImportTask, TaskHandler } from "@culiu/tasks";

interface AuthorizationRow {
  readonly active: boolean;
  readonly actor_user_id: string;
  readonly allowed_actions: string[];
  readonly context_hash: string;
  readonly expires_at: Date;
  readonly role: "admin" | "advisor" | "auditor" | "service";
  readonly student_id: string | null;
}

interface BackgroundJobRow {
  readonly attempts: number;
  readonly authorization_context_id: string;
  readonly claim_token: string | null;
  readonly id: string;
  readonly idempotency_key: string;
  readonly lease_expires_at: Date | null;
  readonly max_attempts: number;
  readonly result_reference: Record<string, unknown> | null;
  readonly status: "canceled" | "failed" | "queued" | "running" | "succeeded";
  readonly task_name: string;
}

interface StartJobResult {
  readonly claimToken?: string;
  readonly completedResult?: Record<string, unknown>;
  readonly shouldRun: boolean;
  readonly terminalAudit?: KnowledgeImportAuditEvent;
  readonly terminalFailure?: boolean;
}

const DATABASE_JOB_LEASE_SECONDS = 25;

interface AuthorizedActor {
  readonly actorType: "service" | "user";
  readonly actorUserId: string;
}

export interface KnowledgeImportTaskHandlerOptions {
  readonly auditWriter?: KnowledgeImportAuditWriter;
  readonly databaseClient: DatabaseClient;
  readonly importer: KnowledgeImporter;
}

export interface KnowledgeImportAuditEvent {
  readonly actorType: "service" | "user";
  readonly actorUserId: string;
  readonly details: Record<string, unknown>;
  readonly objectId: string;
  readonly objectType: "background_job" | "knowledge_import_batch";
  readonly result: "failure" | "success";
  readonly task: KnowledgeImportTask;
}

export type KnowledgeImportAuditWriter = (event: KnowledgeImportAuditEvent) => Promise<void>;

async function transaction<T>(connection: DatabaseConnection, work: () => Promise<T>): Promise<T> {
  await connection.query("begin");
  try {
    const result = await work();
    await connection.query("commit");
    return result;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  }
}

async function authorizeTask(
  databaseClient: DatabaseClient,
  task: KnowledgeImportTask,
): Promise<AuthorizedActor> {
  const result = await databaseClient.pool.query<AuthorizationRow>(
    `select context.actor_user_id, context.student_id, context.allowed_actions,
            context.context_hash, context.expires_at, actor.role, actor.active
       from authorization_context_snapshot context
       join app_user actor on actor.id = context.actor_user_id
      where context.id = $1`,
    [task.authorization.contextId],
  );
  const authorization = result.rows[0];
  if (
    authorization === undefined ||
    authorization.context_hash !== task.authorization.contextHash ||
    authorization.student_id !== null ||
    !authorization.allowed_actions.includes("knowledge.import") ||
    authorization.expires_at.getTime() <= Date.now() ||
    !authorization.active ||
    !["admin", "service"].includes(authorization.role)
  ) {
    throw new KnowledgeImportError(
      "authorization_denied",
      "authorization",
      "Frozen authorization context does not permit a knowledge import.",
    );
  }
  return {
    actorType: authorization.role === "service" ? "service" : "user",
    actorUserId: authorization.actor_user_id,
  };
}

async function startBackgroundJob(
  databaseClient: DatabaseClient,
  task: KnowledgeImportTask,
  actor: AuthorizedActor,
  auditWriter?: KnowledgeImportAuditWriter,
): Promise<StartJobResult> {
  const connection = await databaseClient.pool.connect();
  try {
    const result = await transaction(connection, async () => {
      await connection.query(
        `insert into background_job
          (id, task_name, authorization_context_id, idempotency_key)
         values ($1, $2, $3, $4)
         on conflict (id) do nothing`,
        [task.taskId, task.taskName, task.authorization.contextId, task.idempotencyKey],
      );
      const result = await connection.query<BackgroundJobRow>(
        `select id, task_name, authorization_context_id, idempotency_key, status,
                attempts, max_attempts, claim_token, lease_expires_at, result_reference
           from background_job
          where id = $1
          for update`,
        [task.taskId],
      );
      const job = result.rows[0];
      if (
        job === undefined ||
        job.task_name !== task.taskName ||
        job.authorization_context_id !== task.authorization.contextId ||
        job.idempotency_key !== task.idempotencyKey
      ) {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          "Background job identity does not match the validated queue task.",
        );
      }
      if (job.status === "succeeded") {
        return {
          ...(job.result_reference === null ? {} : { completedResult: job.result_reference }),
          shouldRun: false,
        };
      }
      if (job.status === "canceled") {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          `Background job cannot start from state ${job.status}.`,
        );
      }
      if (
        job.status === "running" &&
        job.lease_expires_at !== null &&
        job.lease_expires_at.getTime() > Date.now()
      ) {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          "Background job is still held by an active database lease.",
        );
      }
      if (job.attempts >= job.max_attempts) {
        if (job.status === "running") {
          await connection.query(
            `update background_job
                set status = 'failed', error_code = 'worker_lease_expired',
                    completed_at = now(), claim_token = null, lease_expires_at = null
              where id = $1 and status = 'running'`,
            [task.taskId],
          );
          const auditEvent: KnowledgeImportAuditEvent = {
            actorType: actor.actorType,
            actorUserId: actor.actorUserId,
            details: { errorCode: "worker_lease_expired", stage: "database" },
            objectId: task.taskId,
            objectType: "background_job",
            result: "failure",
            task,
          };
          if (auditWriter === undefined) {
            await insertDatabaseAuditEvent(connection, auditEvent);
          }
          return { shouldRun: false, terminalAudit: auditEvent, terminalFailure: true };
        }
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          "Background job exhausted its retry allowance.",
        );
      }
      const claimToken = randomUUID();
      const claimed = await connection.query(
        `update background_job
            set status = 'running', attempts = attempts + 1, started_at = now(),
                completed_at = null, result_reference = null, error_code = null,
                claim_token = $2,
                lease_expires_at = now() + ($3 * interval '1 second')
          where id = $1
            and (status in ('queued', 'failed')
              or (status = 'running' and lease_expires_at <= now()))`,
        [task.taskId, claimToken, DATABASE_JOB_LEASE_SECONDS],
      );
      if (claimed.rowCount !== 1) {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          "Background job could not be claimed for this attempt.",
        );
      }
      return { claimToken, shouldRun: true };
    });
    if (result.terminalFailure === true) {
      if (auditWriter !== undefined) {
        await auditWriter(result.terminalAudit);
      }
      throw new KnowledgeImportError(
        "database_failed",
        "database",
        "Expired background job lease exhausted its retry allowance.",
      );
    }
    return result;
  } finally {
    connection.release();
  }
}

async function completeBackgroundJob(
  databaseClient: DatabaseClient,
  task: KnowledgeImportTask,
  claimToken: string,
  resultReference: Record<string, unknown>,
  auditEvent?: KnowledgeImportAuditEvent,
): Promise<void> {
  const connection = await databaseClient.pool.connect();
  try {
    await transaction(connection, async () => {
      const result = await connection.query(
        `update background_job
            set status = 'succeeded', result_reference = $2, error_code = null,
                completed_at = now(), claim_token = null, lease_expires_at = null
          where id = $1 and status = 'running' and claim_token = $3`,
        [task.taskId, JSON.stringify(resultReference), claimToken],
      );
      if (result.rowCount !== 1) {
        throw new KnowledgeImportError(
          "database_failed",
          "finalize",
          "Background job was not running during successful completion.",
        );
      }
      if (auditEvent !== undefined) {
        await insertDatabaseAuditEvent(connection, auditEvent);
      }
    });
  } finally {
    connection.release();
  }
}

async function failBackgroundJob(
  databaseClient: DatabaseClient,
  task: KnowledgeImportTask,
  claimToken: string,
  error: unknown,
  auditEvent?: KnowledgeImportAuditEvent,
): Promise<boolean> {
  const failure = describeImportFailure(error, "database");
  const connection = await databaseClient.pool.connect();
  try {
    return await transaction(connection, async () => {
      const result = await connection.query(
        `update background_job
            set status = 'failed', error_code = $2, completed_at = now(),
                claim_token = null, lease_expires_at = null
          where id = $1 and status = 'running' and claim_token = $3`,
        [task.taskId, failure.code, claimToken],
      );
      if (result.rowCount !== 1) return false;
      if (auditEvent !== undefined) {
        await insertDatabaseAuditEvent(connection, auditEvent);
      }
      return true;
    });
  } finally {
    connection.release();
  }
}

async function insertDatabaseAuditEvent(
  connection: DatabaseConnection,
  event: KnowledgeImportAuditEvent,
): Promise<void> {
  await connection.query(
    `insert into audit_event
      (actor_type, actor_user_id, action, object_type, object_id, result,
       request_correlation_id, details)
     values ($1, $2, 'knowledge.import', $3, $4, $5, $6, $7)`,
    [
      event.actorType,
      event.actorUserId,
      event.objectType,
      event.objectId,
      event.result,
      event.task.payload.correlationId,
      JSON.stringify(event.details),
    ],
  );
}

export function createKnowledgeImportTaskHandler(
  options: KnowledgeImportTaskHandlerOptions,
): TaskHandler {
  return async (taskEnvelope) => {
    if (taskEnvelope.taskName !== "knowledge.import") {
      throw new TypeError("Knowledge import handler received an incompatible task envelope.");
    }
    const task = taskEnvelope;
    const actor = await authorizeTask(options.databaseClient, task);
    const job = await startBackgroundJob(options.databaseClient, task, actor, options.auditWriter);
    if (!job.shouldRun) {
      return job.completedResult ?? { status: "already_completed" };
    }
    if (job.claimToken === undefined) {
      throw new KnowledgeImportError(
        "database_failed",
        "database",
        "Background job claim did not return a lease token.",
      );
    }

    try {
      const result = await options.importer.import({
        actorUserId: actor.actorUserId,
        backgroundJobId: task.taskId,
        corpusHash: task.payload.corpusHash,
        corpusId: task.payload.corpusId,
        manifestVersion: task.payload.manifestVersion,
        mappingVersion: task.payload.mappingVersion,
      });
      const resultReference: Record<string, unknown> = {
        batchId: result.batchId,
        documentCounts: result.documentCounts,
        status: result.status,
      };
      const auditEvent: KnowledgeImportAuditEvent = {
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        details: {
          corpusHash: task.payload.corpusHash,
          documentCounts: result.documentCounts,
          importStatus: result.status,
        },
        objectId: result.batchId,
        objectType: "knowledge_import_batch",
        result: "success",
        task,
      };
      await completeBackgroundJob(
        options.databaseClient,
        task,
        job.claimToken,
        resultReference,
        options.auditWriter === undefined ? auditEvent : undefined,
      );
      if (options.auditWriter !== undefined) {
        await options.auditWriter(auditEvent);
      }
      return resultReference;
    } catch (error) {
      const failure = describeImportFailure(error, "database");
      const auditEvent: KnowledgeImportAuditEvent = {
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        details: { errorCode: failure.code, stage: failure.stage },
        objectId: task.taskId,
        objectType: "background_job",
        result: "failure",
        task,
      };
      const failedCurrentLease = await failBackgroundJob(
        options.databaseClient,
        task,
        job.claimToken,
        error,
        options.auditWriter === undefined ? auditEvent : undefined,
      ).catch(() => false);
      if (failedCurrentLease && options.auditWriter !== undefined) {
        await options.auditWriter(auditEvent).catch(() => undefined);
      }
      throw error;
    }
  };
}
