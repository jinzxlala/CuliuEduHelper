import Redis from "ioredis";
import { z } from "zod";

const RedisConfigSchema = z.object({
  REDIS_URL: z
    .url()
    .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
      message: "REDIS_URL must use redis:// or rediss://",
    }),
});

export function parseRedisUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return RedisConfigSchema.parse(environment).REDIS_URL;
}

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

export async function checkRedisConnection(connection: Redis): Promise<void> {
  if (connection.status === "wait") {
    await connection.connect();
  }
  await connection.ping();
}
