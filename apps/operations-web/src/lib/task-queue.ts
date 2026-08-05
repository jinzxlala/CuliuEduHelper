import "server-only";

import { createRedisConnection, createTaskQueue, parseRedisUrl } from "@culiu/tasks";

const globalTasks = globalThis as typeof globalThis & {
  culiuOperationsTaskQueue?: ReturnType<typeof createTaskQueue>;
  culiuOperationsTaskRedis?: ReturnType<typeof createRedisConnection>;
};

export function getTaskQueue(): ReturnType<typeof createTaskQueue> {
  const redis = getTaskRedisConnection();
  globalTasks.culiuOperationsTaskQueue ??= createTaskQueue({
    connection: redis,
    ...(process.env.CULIU_TASK_QUEUE_NAME === undefined
      ? {}
      : { queueName: process.env.CULIU_TASK_QUEUE_NAME }),
  });
  return globalTasks.culiuOperationsTaskQueue;
}

export function getTaskRedisConnection(): ReturnType<typeof createRedisConnection> {
  globalTasks.culiuOperationsTaskRedis ??= createRedisConnection(parseRedisUrl());
  return globalTasks.culiuOperationsTaskRedis;
}
