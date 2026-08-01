import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { verifyKnowledgeSourceManifest } from "@culiu/knowledge-ingest";
import {
  createRedisConnection,
  createTaskQueue,
  enqueueTask,
  parseRedisUrl,
  type KnowledgeImportTask,
} from "@culiu/tasks";

import { parseWorkerRuntimeConfig } from "../config.js";
import { resolveKnowledgeImportAuthorization } from "../import-authorization.js";

function deterministicTaskId(identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ["8", "9", "a", "b"][Number.parseInt(digest[16] ?? "0", 16) % 4] ?? "8";
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main(): Promise<void> {
  const runtime = parseWorkerRuntimeConfig();
  const manifest = verifyKnowledgeSourceManifest(
    JSON.parse(await readFile(runtime.manifestPath, "utf8")) as unknown,
  );
  const redis = createRedisConnection(parseRedisUrl());
  const queue = createTaskQueue({ connection: redis });
  try {
    const identity = `${manifest.corpus_id}:${manifest.corpus_hash}:${manifest.mapping_version}:${manifest.manifest_version}`;
    const forceNewTask = process.argv.includes("--new-task");
    const verificationSuffix = forceNewTask
      ? `_${randomUUID().replaceAll("-", "").slice(0, 8)}`
      : "";
    const task: KnowledgeImportTask = {
      authorization: resolveKnowledgeImportAuthorization(),
      idempotencyKey: `knowledge_import_${manifest.corpus_hash.slice(0, 32)}_${manifest.mapping_version.replaceAll(".", "")}_${manifest.manifest_version.replaceAll(".", "")}${verificationSuffix}`,
      payload: {
        correlationId: randomUUID(),
        corpusHash: manifest.corpus_hash,
        corpusId: manifest.corpus_id,
        manifestVersion: manifest.manifest_version,
        mappingVersion: manifest.mapping_version,
        sourceProfile: "eduknow-local-v1",
      },
      taskId: forceNewTask ? randomUUID() : deterministicTaskId(identity),
      taskName: "knowledge.import",
    };
    const jobId = await enqueueTask(queue, task);
    process.stdout.write(`${JSON.stringify({ jobId, taskId: task.taskId })}\n`);
  } finally {
    await queue.close();
    await redis.quit();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Knowledge import enqueue failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
