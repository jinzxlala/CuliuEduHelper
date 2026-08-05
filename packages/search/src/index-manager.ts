import { randomUUID } from "node:crypto";

import { MeilisearchApiError, type Meilisearch, type Settings, type Task } from "meilisearch";

import { type KnowledgeDocumentSet } from "./documents.js";
import {
  DEFAULT_KNOWLEDGE_INDEX_NAMES,
  KNOWLEDGE_INDEX_DEFINITIONS,
  KnowledgeIndexNamesSchema,
  type KnowledgeIndexNames,
} from "./index-definitions.js";
import { validateKnowledgeDocumentSet } from "./integrity.js";

export class KnowledgeIndexTaskError extends Error {
  public readonly errorCode: string | undefined;
  public readonly taskUid: number;

  public constructor(task: Task) {
    super(`Meilisearch task ${String(task.uid)} did not succeed.`);
    this.name = "KnowledgeIndexTaskError";
    this.errorCode = task.error?.code;
    this.taskUid = task.uid;
  }
}

export class KnowledgeIndexDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnowledgeIndexDefinitionError";
  }
}

export class KnowledgeIndexCleanupError extends Error {
  public readonly orphanedIndexes: string[];

  public constructor(orphanedIndexes: string[], cause: unknown) {
    super(`Failed to remove temporary indexes: ${orphanedIndexes.join(", ")}.`, { cause });
    this.name = "KnowledgeIndexCleanupError";
    this.orphanedIndexes = orphanedIndexes;
  }
}

export interface KnowledgeIndexManagerOptions {
  client: Meilisearch;
  enableEmbedders?: boolean;
  indexNames?: KnowledgeIndexNames;
  taskTimeoutMs?: number;
}

export interface KnowledgeIndexRebuildResult {
  documentCounts: {
    cases: number;
    lectures: number;
    transcriptSegments: number;
  };
  orphanedIndexes: string[];
}

interface IndexBuildTarget {
  definition: (typeof KNOWLEDGE_INDEX_DEFINITIONS)[keyof typeof KNOWLEDGE_INDEX_DEFINITIONS];
  documents: Array<Record<string, unknown>>;
  targetUid: string;
  temporaryUid: string;
}

function settingsFor(
  definition: (typeof KNOWLEDGE_INDEX_DEFINITIONS)[keyof typeof KNOWLEDGE_INDEX_DEFINITIONS],
  enableEmbedders: boolean,
): Settings {
  const embedder = definition.embedder;
  return {
    ...(enableEmbedders && embedder !== undefined
      ? {
          embedders: {
            [embedder.name]: {
              documentTemplate: embedder.documentTemplate,
              model: embedder.model,
              revision: embedder.revision,
              source: embedder.source,
            },
          },
        }
      : {}),
    filterableAttributes: definition.filterableAttributes,
    searchableAttributes: definition.searchableAttributes,
    sortableAttributes: definition.sortableAttributes,
  };
}

function isIndexNotFound(error: unknown): boolean {
  return error instanceof MeilisearchApiError && error.cause?.code === "index_not_found";
}

export class KnowledgeIndexManager {
  readonly #client: Meilisearch;
  readonly #enableEmbedders: boolean;
  readonly #indexNames: KnowledgeIndexNames;
  readonly #taskTimeoutMs: number;

  public constructor(options: KnowledgeIndexManagerOptions) {
    this.#client = options.client;
    this.#enableEmbedders = options.enableEmbedders ?? true;
    this.#indexNames = KnowledgeIndexNamesSchema.parse(
      options.indexNames ?? DEFAULT_KNOWLEDGE_INDEX_NAMES,
    );
    this.#taskTimeoutMs = options.taskTimeoutMs ?? 60_000;
    if (!Number.isInteger(this.#taskTimeoutMs) || this.#taskTimeoutMs <= 0) {
      throw new RangeError("taskTimeoutMs must be a positive integer.");
    }
  }

  async #waitForSuccess(taskUid: number): Promise<Task> {
    const task = await this.#client.tasks.waitForTask(taskUid, {
      interval: 50,
      timeout: this.#taskTimeoutMs,
    });
    if (task.status !== "succeeded") {
      throw new KnowledgeIndexTaskError(task);
    }
    return task;
  }

  async #ensureTargetIndex(uid: string, primaryKey: string): Promise<void> {
    try {
      const existing = await this.#client.getRawIndex(uid);
      if (existing.primaryKey !== primaryKey) {
        throw new KnowledgeIndexDefinitionError(
          `Index ${uid} uses primary key ${existing.primaryKey ?? "<unset>"}, expected ${primaryKey}.`,
        );
      }
    } catch (error) {
      if (!isIndexNotFound(error)) {
        throw error;
      }
      const task = await this.#client.createIndex(uid, { primaryKey });
      await this.#waitForSuccess(task.taskUid);
    }
  }

  async #deleteIndex(uid: string): Promise<boolean> {
    try {
      const task = await this.#client.deleteIndex(uid);
      await this.#waitForSuccess(task.taskUid);
      return true;
    } catch (error) {
      if (isIndexNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  async #cleanupTemporaryIndexes(targets: readonly IndexBuildTarget[]): Promise<string[]> {
    const cleanupResults = await Promise.allSettled(
      targets.map(async (target) => {
        await this.#deleteIndex(target.temporaryUid);
        return target.temporaryUid;
      }),
    );
    return cleanupResults.flatMap((result, index) => {
      const target = targets[index];
      return result.status === "rejected" && target !== undefined ? [target.temporaryUid] : [];
    });
  }

  #buildTargets(documents: KnowledgeDocumentSet): IndexBuildTarget[] {
    const suffix = randomUUID().replaceAll("-", "");
    return [
      {
        definition: KNOWLEDGE_INDEX_DEFINITIONS.lectures,
        documents: documents.lectures.map((document) => ({ ...document })),
        targetUid: this.#indexNames.lectures,
        temporaryUid: `${this.#indexNames.lectures}_rebuild_${suffix}`,
      },
      {
        definition: KNOWLEDGE_INDEX_DEFINITIONS.cases,
        documents: documents.cases.map((document) => ({ ...document })),
        targetUid: this.#indexNames.cases,
        temporaryUid: `${this.#indexNames.cases}_rebuild_${suffix}`,
      },
      {
        definition: KNOWLEDGE_INDEX_DEFINITIONS.transcriptSegments,
        documents: documents.transcriptSegments.map((document) => ({ ...document })),
        targetUid: this.#indexNames.transcriptSegments,
        temporaryUid: `${this.#indexNames.transcriptSegments}_rebuild_${suffix}`,
      },
    ];
  }

  public async ensureKnowledgeIndexes(): Promise<void> {
    const targets = this.#buildTargets({ cases: [], lectures: [], transcriptSegments: [] });
    for (const target of targets) {
      await this.#ensureTargetIndex(target.targetUid, target.definition.primaryKey);
      const task = await this.#client
        .index(target.targetUid)
        .updateSettings(settingsFor(target.definition, this.#enableEmbedders));
      await this.#waitForSuccess(task.taskUid);
    }
  }

  public async rebuildKnowledgeIndexes(
    untrustedDocuments: KnowledgeDocumentSet,
  ): Promise<KnowledgeIndexRebuildResult> {
    const documents = validateKnowledgeDocumentSet(untrustedDocuments);
    const targets = this.#buildTargets(documents);
    let indexesSwapped = false;

    try {
      for (const target of targets) {
        const createTask = await this.#client.createIndex(target.temporaryUid, {
          primaryKey: target.definition.primaryKey,
        });
        await this.#waitForSuccess(createTask.taskUid);

        const settingsTask = await this.#client
          .index(target.temporaryUid)
          .updateSettings(settingsFor(target.definition, this.#enableEmbedders));
        await this.#waitForSuccess(settingsTask.taskUid);

        if (target.documents.length > 0) {
          const documentsTask = await this.#client
            .index<Record<string, unknown>>(target.temporaryUid)
            .addDocuments(target.documents);
          await this.#waitForSuccess(documentsTask.taskUid);
        }
      }

      for (const target of targets) {
        await this.#ensureTargetIndex(target.targetUid, target.definition.primaryKey);
      }

      const swapTask = await this.#client.swapIndexes(
        targets.map((target) => ({
          indexes: [target.targetUid, target.temporaryUid],
          rename: false,
        })),
      );
      await this.#waitForSuccess(swapTask.taskUid);
      indexesSwapped = true;
    } catch (error) {
      if (!indexesSwapped) {
        const orphanedIndexes = await this.#cleanupTemporaryIndexes(targets);
        if (orphanedIndexes.length > 0) {
          throw new KnowledgeIndexCleanupError(orphanedIndexes, error);
        }
      }
      throw error;
    }

    const orphanedIndexes = await this.#cleanupTemporaryIndexes(targets);

    return {
      documentCounts: {
        cases: documents.cases.length,
        lectures: documents.lectures.length,
        transcriptSegments: documents.transcriptSegments.length,
      },
      orphanedIndexes,
    };
  }
}
