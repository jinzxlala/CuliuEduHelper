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

export const KnowledgeExtractTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      correlationId: z.uuid(),
      gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
      model: z.literal("deepseek-v4-flash"),
      modelInputHash: z.string().regex(/^[0-9a-f]{64}$/u),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
      promptVersion: z.literal("knowledge-transcript-extraction.v3"),
      redactionVersion: z.literal("knowledge-transcript-outbound.v1"),
      schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
      schemaVersion: z.literal("knowledge-analysis-markdown.v3"),
      submissionId: z.uuid(),
      transcriptTextHash: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("knowledge.extract"),
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

export const StudentBasicExtractTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      batchId: z.uuid(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
      correlationId: z.uuid(),
      gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
      model: z.literal("deepseek-v4-flash"),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
      promptVersion: z.literal("student-basic-import.v1"),
      redactionVersion: z.literal("student-basic-minimal-outbound.v1"),
      schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
      schemaVersion: z.literal("student-basic-candidates.v1"),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("student.basic.extract"),
});

export const StudentEvidenceExtractTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      batchId: z.uuid(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
      correlationId: z.uuid(),
      gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
      model: z.literal("deepseek-v4-flash"),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
      promptVersion: z.literal("student-evidence-extract.v1"),
      redactionVersion: z.literal("student-evidence-minimal-outbound.v1"),
      schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
      schemaVersion: z.literal("student-fact-suggestions.v1"),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("student.evidence.extract"),
});

export const CourseRecommendationGenerateTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      correlationId: z.uuid(),
      gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
      model: z.literal("deepseek-v4-flash"),
      pricingVersion: z.literal("deepseek-v4-flash-cny-2026-08-02"),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
      promptVersion: z.literal("course-recommendation.v1"),
      redactionVersion: z.literal("course-recommendation-outbound.v1"),
      schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
      schemaVersion: z.literal("course-recommendation-output.v1"),
      snapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
      snapshotId: z.uuid(),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("course.recommendation.generate"),
});

export const TimetableSolveTaskSchema = z.object({
  authorization: AuthorizationSnapshotReferenceSchema,
  idempotencyKey: TaskIdempotencyKeySchema,
  payload: z
    .object({
      constraintVersion: z.literal("class-teacher-candidate.v1"),
      correlationId: z.uuid(),
      gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
      inputHash: z.string().regex(/^[0-9a-f]{64}$/u),
      objectiveVersion: z.literal("priority-schedule-teacher-gap-stable.v1"),
      runId: z.uuid(),
      solverVersion: z.literal("highs-wasm-1.15.2"),
    })
    .strict(),
  taskId: z.uuid(),
  taskName: z.literal("timetable.solve"),
});

export const TaskEnvelopeSchema = z.discriminatedUnion("taskName", [
  SystemProbeTaskSchema,
  KnowledgeImportTaskSchema,
  KnowledgeExtractTaskSchema,
  ProfileDraftTaskSchema,
  StudentBasicExtractTaskSchema,
  StudentEvidenceExtractTaskSchema,
  CourseRecommendationGenerateTaskSchema,
  TimetableSolveTaskSchema,
]);
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;
export type TaskName = TaskEnvelope["taskName"];
export type KnowledgeImportTask = z.infer<typeof KnowledgeImportTaskSchema>;
export type KnowledgeExtractTask = z.infer<typeof KnowledgeExtractTaskSchema>;
export type ProfileDraftTask = z.infer<typeof ProfileDraftTaskSchema>;
export type StudentBasicExtractTask = z.infer<typeof StudentBasicExtractTaskSchema>;
export type StudentEvidenceExtractTask = z.infer<typeof StudentEvidenceExtractTaskSchema>;
export type CourseRecommendationGenerateTask = z.infer<
  typeof CourseRecommendationGenerateTaskSchema
>;
export type TimetableSolveTask = z.infer<typeof TimetableSolveTaskSchema>;
