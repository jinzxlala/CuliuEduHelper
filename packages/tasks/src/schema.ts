import { z } from "zod";

export const TASK_QUEUE_NAME = "culiu-tasks";

export const AuthorizationSnapshotReferenceSchema = z.object({
  contextId: z.uuid(),
  contextHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const SystemProbeTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  payload: z.object({
    correlationId: z.uuid(),
  }),
  taskId: z.uuid(),
  taskName: z.literal("system.probe"),
});

export const TaskEnvelopeSchema = z.discriminatedUnion("taskName", [SystemProbeTaskSchema]);
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;
export type TaskName = TaskEnvelope["taskName"];
