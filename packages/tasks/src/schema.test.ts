import { randomUUID } from "node:crypto";

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
  it("accepts a minimal student basic extraction task without source content", () => {
    const task = TaskEnvelopeSchema.parse({
      authorization: { contextHash: "a".repeat(64), contextId: randomUUID() },
      idempotencyKey: "student-basic-extract-1",
      payload: {
        batchId: randomUUID(),
        contentHash: "b".repeat(64),
        correlationId: randomUUID(),
        gitCommitSha: "c".repeat(40),
        model: "deepseek-v4-flash",
        promptHash: "d".repeat(64),
        promptVersion: "student-basic-import.v1",
        redactionVersion: "student-basic-minimal-outbound.v1",
        schemaHash: "e".repeat(64),
        schemaVersion: "student-basic-candidates.v1",
      },
      taskId: randomUUID(),
      taskName: "student.basic.extract",
    });
    expect(task.taskName).toBe("student.basic.extract");
    expect(JSON.stringify(task)).not.toContain("学生");
  });

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

  it("accepts a transcript extraction task containing references and hashes but no transcript", () => {
    const task = {
      ...validTask,
      idempotencyKey: "knowledge_extract_001",
      payload: {
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "c".repeat(40),
        model: "deepseek-v4-flash",
        modelInputHash: "d".repeat(64),
        promptHash: "e".repeat(64),
        promptVersion: "knowledge-transcript-extraction.v4",
        redactionVersion: "knowledge-transcript-outbound.v1",
        schemaHash: "f".repeat(64),
        schemaVersion: "knowledge-analysis-markdown.v4",
        submissionId: "00000000-0000-4000-8000-000000000021",
        transcriptTextHash: "1".repeat(64),
      },
      taskName: "knowledge.extract",
    } as const;

    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain('"transcriptText":');
    expect(JSON.stringify(task)).not.toContain("originalFileName");
    expect(() =>
      TaskEnvelopeSchema.parse({
        ...task,
        payload: { ...task.payload, promptVersion: "knowledge-transcript-extraction.v2" },
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
        promptVersion: "profile-draft-prompt.v3",
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

  it("accepts a course recommendation task with frozen references and no student content", () => {
    const task = {
      ...validTask,
      idempotencyKey: `course_rec_${"a".repeat(64)}`,
      payload: {
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "b".repeat(40),
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptHash: "c".repeat(64),
        promptVersion: "course-recommendation.v1",
        redactionVersion: "course-recommendation-outbound.v1",
        schemaHash: "d".repeat(64),
        schemaVersion: "course-recommendation-output.v1",
        snapshotHash: "a".repeat(64),
        snapshotId: "00000000-0000-4000-8000-000000000031",
      },
      taskName: "course.recommendation.generate",
    } as const;
    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain("studentId");
    expect(JSON.stringify(task)).not.toContain("claims");
  });

  it("accepts a timetable task with only a run reference and version hashes", () => {
    const task = {
      ...validTask,
      idempotencyKey: `timetable_${"a".repeat(64)}`,
      payload: {
        constraintVersion: "class-teacher-candidate.v1",
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "b".repeat(40),
        inputHash: "a".repeat(64),
        objectiveVersion: "priority-schedule-teacher-gap-stable.v1",
        runId: "00000000-0000-4000-8000-000000000041",
        solverVersion: "highs-wasm-1.15.2",
      },
      taskName: "timetable.solve",
    } as const;
    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain("studentRosterText");
    expect(JSON.stringify(task)).not.toContain("occurrences");
  });

  it("accepts a smart-search task containing only frozen run and version references", () => {
    const task = {
      ...validTask,
      idempotencyKey: `smart_search_${"a".repeat(64)}`,
      payload: {
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "b".repeat(40),
        model: "deepseek-v4-flash",
        promptVersion: "knowledge-smart-search.v1",
        retrievalVersion: "knowledge-hybrid.v1",
        runId: "00000000-0000-4000-8000-000000000051",
        schemaVersion: "knowledge-smart-search-output.v1",
      },
      taskName: "knowledge.smart-search",
    } as const;
    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain("promptText");
    expect(JSON.stringify(task)).not.toContain("candidateDocuments");
  });

  it("accepts an analysis-chat task containing only frozen context references", () => {
    const task = {
      ...validTask,
      idempotencyKey: `analysis_chat_${"a".repeat(64)}`,
      payload: {
        contextVersion: "knowledge-analysis-context.v1",
        conversationId: "00000000-0000-4000-8000-000000000061",
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "b".repeat(40),
        inputSnapshotHash: "c".repeat(64),
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptVersion: "knowledge-analysis-chat.v1",
        runId: "00000000-0000-4000-8000-000000000062",
        schemaVersion: "knowledge-analysis-chat-output.v1",
        workspaceId: "00000000-0000-4000-8000-000000000063",
      },
      taskName: "knowledge.analysis-chat",
    } as const;
    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain("messageContent");
    expect(JSON.stringify(task)).not.toContain("sourceDocuments");
  });

  it("accepts an analysis-report task without conversation or source bodies", () => {
    const task = {
      ...validTask,
      idempotencyKey: `analysis_report_${"a".repeat(64)}`,
      payload: {
        contextVersion: "knowledge-analysis-report-context.v1",
        conversationId: "00000000-0000-4000-8000-000000000071",
        correlationId: validTask.payload.correlationId,
        gitCommitSha: "b".repeat(40),
        inputSnapshotHash: "c".repeat(64),
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptVersion: "knowledge-analysis-report.v1",
        reportId: "00000000-0000-4000-8000-000000000072",
        schemaVersion: "knowledge-analysis-report-output.v1",
        templateVersion: "knowledge-analysis-report-html.v1",
        workspaceId: "00000000-0000-4000-8000-000000000073",
      },
      taskName: "knowledge.analysis-report",
    } as const;
    expect(TaskEnvelopeSchema.parse(task)).toEqual(task);
    expect(JSON.stringify(task)).not.toContain("conversationMessages");
    expect(JSON.stringify(task)).not.toContain("sourceDocuments");
  });
});
