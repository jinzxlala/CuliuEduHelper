import "server-only";

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { checkDatabaseConnection } from "@culiu/database/runtime";
import { checkRedisConnection } from "@culiu/tasks";
import { z } from "zod";

import { getDatabaseClient } from "./database";
import { getTaskRedisConnection } from "./task-queue";

const ReadinessCheckSchema = z.enum(["available", "unavailable"]);

export const WebReadinessSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    checks: z
      .object({
        database: ReadinessCheckSchema,
        objectStorage: ReadinessCheckSchema,
        redis: ReadinessCheckSchema,
        taskVersion: ReadinessCheckSchema,
      })
      .strict(),
    service: z.literal("operations-web"),
    status: z.enum(["ready", "not_ready"]),
  })
  .strict();

export type WebReadiness = z.infer<typeof WebReadinessSchema>;

export interface ReadinessProbes {
  readonly database: () => Promise<void>;
  readonly objectStorage: () => Promise<void>;
  readonly redis: () => Promise<void>;
  readonly taskVersion: () => Promise<void>;
}

function storageRoot(environment: NodeJS.ProcessEnv): string {
  const root = environment.LOCAL_STORAGE_ROOT?.trim();
  if (root === undefined || root === "" || !isAbsolute(root)) {
    throw new Error("LOCAL_STORAGE_ROOT must be an absolute server-side path.");
  }
  return root;
}

export function createReadinessProbes(
  environment: NodeJS.ProcessEnv = process.env,
): ReadinessProbes {
  return {
    database: () => checkDatabaseConnection(getDatabaseClient()),
    objectStorage: () => access(storageRoot(environment), constants.R_OK | constants.W_OK),
    redis: () => checkRedisConnection(getTaskRedisConnection()),
    taskVersion: () => {
      if (!/^[0-9a-f]{40}$/u.test(environment.CULIU_GIT_COMMIT_SHA?.trim() ?? "")) {
        return Promise.reject(new Error("CULIU_GIT_COMMIT_SHA is invalid."));
      }
      return Promise.resolve();
    },
  };
}

export async function buildWebReadiness(
  probes: ReadinessProbes = createReadinessProbes(),
  now: Date = new Date(),
): Promise<WebReadiness> {
  const [database, objectStorage, redis, taskVersion] = await Promise.allSettled([
    probes.database(),
    probes.objectStorage(),
    probes.redis(),
    probes.taskVersion(),
  ]);
  const checks = {
    database: database.status === "fulfilled" ? "available" : "unavailable",
    objectStorage: objectStorage.status === "fulfilled" ? "available" : "unavailable",
    redis: redis.status === "fulfilled" ? "available" : "unavailable",
    taskVersion: taskVersion.status === "fulfilled" ? "available" : "unavailable",
  } as const;
  return WebReadinessSchema.parse({
    checkedAt: now.toISOString(),
    checks,
    service: "operations-web",
    status: Object.values(checks).every((status) => status === "available") ? "ready" : "not_ready",
  });
}
