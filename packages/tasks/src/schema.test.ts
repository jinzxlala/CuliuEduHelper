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
});
