import "server-only";

import { createRedisConnection, createTaskQueue, parseRedisUrl } from "@culiu/tasks";

const globalTasks = globalThis as typeof globalThis & {
  culiuTaskQueue?: ReturnType<typeof createTaskQueue>;
  culiuTaskRedis?: ReturnType<typeof createRedisConnection>;
};

export function getTaskQueue(): ReturnType<typeof createTaskQueue> {
  globalTasks.culiuTaskRedis ??= createRedisConnection(parseRedisUrl());
  globalTasks.culiuTaskQueue ??= createTaskQueue({
    connection: globalTasks.culiuTaskRedis,
    ...(process.env.CULIU_TASK_QUEUE_NAME === undefined
      ? {}
      : { queueName: process.env.CULIU_TASK_QUEUE_NAME }),
  });
  return globalTasks.culiuTaskQueue;
}
