import { z } from "zod";

export const TASK_QUEUE_NAME = "culiu-tasks";

export const AuthorizationSnapshotReferenceSchema = z.object({
  contextId: z.uuid(),
  contextHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

const TaskIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const SystemProbeTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z.object({
    correlationId: z.uuid(),
  }),
  taskId: z.uuid(),
  taskName: z.literal("system.probe"),
});

export const KnowledgeImportTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      correlationId: z.uuid(),
      corpusHash: z.string().regex(/^[0-9a-f]{64}$/u),
      corpusId: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/u)
        .max(128),
      manifestVersion: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/u)
        .max(32),
      mappingVersion: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/u)
        .max(32),
      sourceProfile: z.literal("eduknow-local-v1"),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("knowledge.import"),
});

export const ProfileDraftTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      correlationId: z.uuid(),
      gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
      inputSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
      inputSnapshotId: z.uuid(),
      model: z.literal("deepseek-v4-flash"),
      pricingVersion: z.literal("deepseek-v4-flash-cny-2026-08-02"),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
      promptVersion: z.literal("profile-draft-prompt.v1"),
      redactionVersion: z.literal("profile-outbound.v1"),
      schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
      schemaVersion: z.literal("profile-draft-output.v1"),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("profile.draft"),
});

export const TaskEnvelopeSchema = z.discriminatedUnion("taskName", [
  SystemProbeTaskSchema,
  KnowledgeImportTaskSchema,
  ProfileDraftTaskSchema,
]);
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;
export type TaskName = TaskEnvelope["taskName"];
export type KnowledgeImportTask = z.infer<typeof KnowledgeImportTaskSchema>;
export type ProfileDraftTask = z.infer<typeof ProfileDraftTaskSchema>;
