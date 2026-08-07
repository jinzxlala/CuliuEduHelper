import type { Meilisearch, Task } from "meilisearch";
import { describe, expect, it } from "vitest";

import type { KnowledgeDocumentSet } from "./documents";
import { KnowledgeIndexManager } from "./index-manager";

const simulatedSlowTaskDurationMs = 60_363;

function successfulTask(uid: number): Task {
  return { status: "succeeded", uid } as Task;
}

function delayedMeilisearchClient(): Meilisearch {
  let nextTaskUid = 1;
  const requiredTimeouts = new Map<number, number>();
  const indexes = new Map<string, { primaryKey: string }>([
    ["lectures", { primaryKey: "lecture_id" }],
    ["cases", { primaryKey: "case_id" }],
    ["transcript_segments", { primaryKey: "segment_id" }],
  ]);

  function task(requiredTimeoutMs = 0): { taskUid: number } {
    const taskUid = nextTaskUid;
    nextTaskUid += 1;
    requiredTimeouts.set(taskUid, requiredTimeoutMs);
    return { taskUid };
  }

  return {
    createIndex(uid: string, options: { primaryKey?: string }) {
      indexes.set(uid, { primaryKey: options.primaryKey ?? "id" });
      return Promise.resolve(task());
    },
    deleteIndex(uid: string) {
      indexes.delete(uid);
      return Promise.resolve(task());
    },
    getRawIndex(uid: string) {
      const index = indexes.get(uid);
      if (index === undefined) return Promise.reject(new Error(`Missing simulated index ${uid}.`));
      return Promise.resolve({ primaryKey: index.primaryKey, uid });
    },
    index() {
      return {
        addDocuments() {
          return Promise.resolve(task(simulatedSlowTaskDurationMs));
        },
        resetEmbedders() {
          return Promise.resolve(task());
        },
        updateSettings() {
          return Promise.resolve(task());
        },
      };
    },
    swapIndexes() {
      return Promise.resolve(task());
    },
    tasks: {
      waitForTask(taskUid: number, options: { timeout?: number }) {
        const required = requiredTimeouts.get(taskUid) ?? 0;
        if ((options.timeout ?? 0) < required) {
          return Promise.reject(new Error(`timeout of ${String(options.timeout)}ms has exceeded`));
        }
        return Promise.resolve(successfulTask(taskUid));
      },
    },
  } as unknown as Meilisearch;
}

const documents: KnowledgeDocumentSet = {
  cases: [],
  lectures: [
    {
      ai_cross_disciplinary_text: "",
      date: "2026-08-07",
      failure_text: "",
      lecture_id: "lecture_timeout_simulation",
      majors: [],
      organization: "虚构机构",
      schools: [],
      source_path: "synthetic/analysis.md",
      speakers: [],
      summary: "用于模拟超过六十秒的索引任务。",
      title: "发布超时模拟",
      trend_text: "",
    },
  ],
  transcriptSegments: [],
};

describe("knowledge index publication timeout", () => {
  it("fails with the former sixty-second timeout", async () => {
    const manager = new KnowledgeIndexManager({
      client: delayedMeilisearchClient(),
      taskTimeoutMs: 60_000,
    });

    await expect(manager.rebuildKnowledgeIndexes(documents)).rejects.toThrow(
      "timeout of 60000ms has exceeded",
    );
  });

  it("allows the default ten-minute timeout to finish the same task", async () => {
    const manager = new KnowledgeIndexManager({
      client: delayedMeilisearchClient(),
    });

    await expect(manager.rebuildKnowledgeIndexes(documents)).resolves.toMatchObject({
      documentCounts: { cases: 0, lectures: 1, transcriptSegments: 0 },
    });
  });
});
