import "server-only";

import { createRedisConnection, createTaskQueue, parseRedisUrl } from "@culiu/tasks";

const globalTasks = globalThis as typeof globalThis & {
  culiuTaskQueue?: ReturnType<typeof createTaskQueue>;
  culiuTaskRedis?: ReturnType<typeof createRedisConnection>;
};

export function getTaskQueue(): ReturnType<typeof createTaskQueue> {
  const redis = getTaskRedisConnection();
  globalTasks.culiuTaskQueue ??= createTaskQueue({
    connection: redis,
    ...(process.env.CULIU_TASK_QUEUE_NAME === undefined
      ? {}
      : { queueName: process.env.CULIU_TASK_QUEUE_NAME }),
  });
  return globalTasks.culiuTaskQueue;
}

export function getTaskRedisConnection(): ReturnType<typeof createRedisConnection> {
  globalTasks.culiuTaskRedis ??= createRedisConnection(parseRedisUrl());
  return globalTasks.culiuTaskRedis;
}
