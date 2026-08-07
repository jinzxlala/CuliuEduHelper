import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createTaskQueue, createTaskWorker, enqueueTask } from "./queue.js";
import { createRedisConnection, parseRedisUrl } from "./redis.js";
import type { TaskEnvelope } from "./schema.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
});

describe("BullMQ foundation", () => {
  it("processes an idempotent authorized task exactly once", async () => {
    const redisUrl = parseRedisUrl();
    const queueConnection = createRedisConnection(redisUrl);
    const workerConnection = createRedisConnection(redisUrl);
    const queueName = `culiu-test-${randomUUID()}`;
    const queue = createTaskQueue({ connection: queueConnection, queueName });
    let processed = 0;
    let resolveCompletion: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const worker = createTaskWorker({
      connection: workerConnection,
      handlers: {
        "knowledge.extract": () => Promise.resolve({ status: "not-used" }),
        "knowledge.import": () => Promise.resolve({ status: "not-used" }),
        "knowledge.smart-search": () => Promise.resolve({ status: "not-used" }),
        "knowledge.analysis-chat": () => Promise.resolve({ status: "not-used" }),
        "knowledge.analysis-report": () => Promise.resolve({ status: "not-used" }),
        "profile.draft": () => Promise.resolve({ status: "not-used" }),
        "student.basic.extract": () => Promise.resolve({ status: "not-used" }),
        "student.evidence.extract": () => Promise.resolve({ status: "not-used" }),
        "course.recommendation.generate": () => Promise.resolve({ status: "not-used" }),
        "timetable.solve": () => Promise.resolve({ status: "not-used" }),
        "system.probe": () => {
          processed += 1;
          resolveCompletion?.();
          return Promise.resolve({ available: true });
        },
      },
      queueName,
    });

    closeCallbacks.push(async () => {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await Promise.all([queueConnection.quit(), workerConnection.quit()]);
    });

    const task: TaskEnvelope = {
      authorization: {
        contextHash: "a".repeat(64),
        contextId: "00000000-0000-4000-8000-000000000004",
      },
      idempotencyKey: `probe_${randomUUID().replaceAll("-", "")}`,
      payload: { correlationId: randomUUID() },
      taskId: randomUUID(),
      taskName: "system.probe",
    };

    const firstJobId = await enqueueTask(queue, task);
    const secondJobId = await enqueueTask(queue, task);
    await completed;

    expect(secondJobId).toBe(firstJobId);
    expect(processed).toBe(1);

    const analysisTask: TaskEnvelope = {
      authorization: {
        contextHash: "b".repeat(64),
        contextId: "00000000-0000-4000-8000-000000000014",
      },
      idempotencyKey: `analysis_chat_${"c".repeat(64)}`,
      payload: {
        contextVersion: "knowledge-analysis-context.v2",
        conversationId: "00000000-0000-4000-8000-000000000015",
        correlationId: "00000000-0000-4000-8000-000000000016",
        gitCommitSha: "d".repeat(40),
        inputSnapshotHash: "e".repeat(64),
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptVersion: "knowledge-analysis-chat.v3",
        runId: "00000000-0000-4000-8000-000000000017",
        schemaVersion: "knowledge-analysis-chat-output.v2",
        workspaceId: "00000000-0000-4000-8000-000000000018",
      },
      taskId: "00000000-0000-4000-8000-000000000019",
      taskName: "knowledge.analysis-chat",
    };
    const analysisJobId = await enqueueTask(queue, analysisTask);
    const analysisJob = await queue.getJob(analysisJobId);
    expect(analysisJob?.opts.attempts).toBe(1);

    const reportTask: TaskEnvelope = {
      authorization: {
        contextHash: "f".repeat(64),
        contextId: "00000000-0000-4000-8000-000000000024",
      },
      idempotencyKey: `analysis_report_${"a".repeat(64)}`,
      payload: {
        contextVersion: "knowledge-analysis-report-context.v2",
        conversationId: "00000000-0000-4000-8000-000000000025",
        correlationId: "00000000-0000-4000-8000-000000000026",
        gitCommitSha: "b".repeat(40),
        inputSnapshotHash: "c".repeat(64),
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptVersion: "knowledge-analysis-report.v4",
        reportId: "00000000-0000-4000-8000-000000000027",
        schemaVersion: "knowledge-analysis-report-output.v1",
        templateVersion: "knowledge-analysis-report-html.v4",
        workspaceId: "00000000-0000-4000-8000-000000000028",
      },
      taskId: "00000000-0000-4000-8000-000000000029",
      taskName: "knowledge.analysis-report",
    };
    const reportJobId = await enqueueTask(queue, reportTask);
    const reportJob = await queue.getJob(reportJobId);
    expect(reportJob?.opts.attempts).toBe(1);
  });
});
