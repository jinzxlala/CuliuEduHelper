import { describe, expect, it } from "vitest";

import { TaskEnvelopeSchema } from "./schema.js";

const validTask = {
  authorization: {
    contextHash: "a".repeat(64),
    contextId: "00000000-0000-4000-8000-000000000004",
  },
  idempotencyKey: "system_probe_001",
  payload: {
    correlationId: "00000000-0000-4000-8000-000000000009",
  },
  taskId: "00000000-0000-4000-8000-000000000010",
  taskName: "system.probe",
} as const;

describe("TaskEnvelopeSchema", () => {
  it("accepts a system probe with a frozen authorization reference", () => {
    expect(TaskEnvelopeSchema.parse(validTask)).toEqual(validTask);
  });

  it("rejects a task without an authorization context", () => {
    expect(() => TaskEnvelopeSchema.parse({ ...validTask, authorization: undefined })).toThrow();
  });

  it("rejects unsafe BullMQ idempotency keys", () => {
    expect(() =>
      TaskEnvelopeSchema.parse({ ...validTask, idempotencyKey: "student:unsafe:key" }),
    ).toThrow();
  });

  it("accepts only the fixed server-side knowledge source profile", () => {
    const importTask = {
      ...validTask,
      idempotencyKey: "knowledge_import_001",
      payload: {
        correlationId: validTask.payload.correlationId,
        corpusHash: "b".repeat(64),
        corpusId: "eduknow_knowledge_sources_v1",
        manifestVersion: "1.0.0",
        mappingVersion: "1.0.0",
        sourceProfile: "eduknow-local-v1",
      },
      taskName: "knowledge.import",
    } as const;

    expect(TaskEnvelopeSchema.parse(importTask)).toEqual(importTask);
    expect(() =>
      TaskEnvelopeSchema.parse({
        ...importTask,
        payload: { ...importTask.payload, sourceProfile: "user-controlled-path" },
      }),
    ).toThrow();
  });

  it("accepts a profile task containing references and version hashes but no student payload", () => {
    const task = {
      ...validTask,
      idempotencyKey: "profile_draft_001",
      payload: {
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "c".repeat(40),
        inputSnapshotHash: "d".repeat(64),
        inputSnapshotId: "00000000-0000-4000-8000-000000000020",
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptHash: "e".repeat(64),
        promptVersion: "profile-draft-prompt.v1",
        redactionVersion: "profile-outbound.v1",
        schemaHash: "f".repeat(64),
        schemaVersion: "profile-draft-output.v1",
      },
      taskName: "profile.draft",
    } as const;

    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain("studentId");
    expect(JSON.stringify(task)).not.toContain("facts");
  });
});
