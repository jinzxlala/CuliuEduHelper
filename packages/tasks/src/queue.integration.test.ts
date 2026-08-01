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
        "knowledge.import": () => Promise.resolve({ status: "not-used" }),
        "profile.draft": () => Promise.resolve({ status: "not-used" }),
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
  });
});
