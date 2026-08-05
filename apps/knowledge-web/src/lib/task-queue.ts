import "server-only";

import { createRedisConnection, createTaskQueue, parseRedisUrl } from "@culiu/tasks";

const globalTasks = globalThis as typeof globalThis & {
  culiuKnowledgeTaskQueue?: ReturnType<typeof createTaskQueue>;
  culiuKnowledgeTaskRedis?: ReturnType<typeof createRedisConnection>;
};

export function getTaskQueue(): ReturnType<typeof createTaskQueue> {
  const redis = getTaskRedisConnection();
  globalTasks.culiuKnowledgeTaskQueue ??= createTaskQueue({
    connection: redis,
    ...(process.env.CULIU_TASK_QUEUE_NAME === undefined
      ? {}
      : { queueName: process.env.CULIU_TASK_QUEUE_NAME }),
  });
  return globalTasks.culiuKnowledgeTaskQueue;
}

export function getTaskRedisConnection(): ReturnType<typeof createRedisConnection> {
  globalTasks.culiuKnowledgeTaskRedis ??= createRedisConnection(parseRedisUrl());
  return globalTasks.culiuKnowledgeTaskRedis;
}
