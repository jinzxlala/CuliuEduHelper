import "server-only";

import { isAbsolute, resolve } from "node:path";

import { LocalImmutableObjectStore } from "@culiu/storage";

const globalObjectStore = globalThis as typeof globalThis & {
  culiuKnowledgeObjectStore?: LocalImmutableObjectStore;
};

export function getKnowledgeObjectStore(): LocalImmutableObjectStore {
  if (globalObjectStore.culiuKnowledgeObjectStore !== undefined) {
    return globalObjectStore.culiuKnowledgeObjectStore;
  }
  const configuredRoot = process.env.LOCAL_STORAGE_ROOT?.trim();
  if (configuredRoot === undefined || configuredRoot === "" || !isAbsolute(configuredRoot)) {
    throw new Error("LOCAL_STORAGE_ROOT must be an absolute server-side path.");
  }
  globalObjectStore.culiuKnowledgeObjectStore = new LocalImmutableObjectStore(
    resolve(configuredRoot),
  );
  return globalObjectStore.culiuKnowledgeObjectStore;
}
