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
        meilisearch: ReadinessCheckSchema,
        objectStorage: ReadinessCheckSchema,
        redis: ReadinessCheckSchema,
        taskVersion: ReadinessCheckSchema,
      })
      .strict(),
    service: z.literal("knowledge-web"),
    status: z.enum(["ready", "not_ready"]),
  })
  .strict();

export type WebReadiness = z.infer<typeof WebReadinessSchema>;

export interface ReadinessProbes {
  readonly database: () => Promise<void>;
  readonly meilisearch: () => Promise<void>;
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

function meilisearchHealthUrl(environment: NodeJS.ProcessEnv): URL {
  const configured = environment.MEILI_HOST?.trim() ?? "http://127.0.0.1:7700";
  const url = new URL(configured);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MEILI_HOST must use http:// or https://.");
  }
  url.pathname = "/health";
  url.search = "";
  return url;
}

export function createReadinessProbes(
  environment: NodeJS.ProcessEnv = process.env,
): ReadinessProbes {
  return {
    database: () => checkDatabaseConnection(getDatabaseClient()),
    meilisearch: async () => {
      const response = await fetch(meilisearchHealthUrl(environment), {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("Meilisearch readiness failed.");
      const body = (await response.json()) as unknown;
      if (
        typeof body !== "object" ||
        body === null ||
        !("status" in body) ||
        body.status !== "available"
      ) {
        throw new Error("Meilisearch returned an invalid health response.");
      }
    },
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
  const [database, meilisearch, objectStorage, redis, taskVersion] = await Promise.allSettled([
    probes.database(),
    probes.meilisearch(),
    probes.objectStorage(),
    probes.redis(),
    probes.taskVersion(),
  ]);
  const checks = {
    database: database.status === "fulfilled" ? "available" : "unavailable",
    meilisearch: meilisearch.status === "fulfilled" ? "available" : "unavailable",
    objectStorage: objectStorage.status === "fulfilled" ? "available" : "unavailable",
    redis: redis.status === "fulfilled" ? "available" : "unavailable",
    taskVersion: taskVersion.status === "fulfilled" ? "available" : "unavailable",
  } as const;
  return WebReadinessSchema.parse({
    checkedAt: now.toISOString(),
    checks,
    service: "knowledge-web",
    status: Object.values(checks).every((status) => status === "available") ? "ready" : "not_ready",
  });
}
