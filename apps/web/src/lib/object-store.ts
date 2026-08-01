import "server-only";

import { isAbsolute, resolve } from "node:path";

import { LocalImmutableObjectStore } from "@culiu/storage";

const globalObjectStore = globalThis as typeof globalThis & {
  culiuStudentObjectStore?: LocalImmutableObjectStore;
};

export function getStudentObjectStore(): LocalImmutableObjectStore {
  if (globalObjectStore.culiuStudentObjectStore !== undefined) {
    return globalObjectStore.culiuStudentObjectStore;
  }
  const configuredRoot = process.env.LOCAL_STORAGE_ROOT?.trim();
  if (configuredRoot === undefined || configuredRoot === "" || !isAbsolute(configuredRoot)) {
    throw new Error("LOCAL_STORAGE_ROOT must be an absolute server-side path.");
  }
  globalObjectStore.culiuStudentObjectStore = new LocalImmutableObjectStore(
    resolve(configuredRoot),
  );
  return globalObjectStore.culiuStudentObjectStore;
}
