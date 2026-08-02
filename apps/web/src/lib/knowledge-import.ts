import "server-only";

import { createHash } from "node:crypto";

import {
  KnowledgeImporter,
  type KnowledgeImportResult,
  type LoadedKnowledgeImport,
} from "@culiu/knowledge-ingest";
import {
  createMeilisearchClient,
  KnowledgeIndexManager,
  parseMeilisearchAdminConfig,
} from "@culiu/search";

import { getDatabaseClient } from "./database";
import { getKnowledgeObjectStore } from "./object-store";

const globalImport = globalThis as typeof globalThis & {
  culiuKnowledgeImporter?: KnowledgeImporter;
};

export function getKnowledgeImporter(): KnowledgeImporter {
  globalImport.culiuKnowledgeImporter ??= new KnowledgeImporter({
    databaseClient: getDatabaseClient(),
    indexPublisher: new KnowledgeIndexManager({
      client: createMeilisearchClient(parseMeilisearchAdminConfig()),
    }),
    manifestPath: process.env.KNOWLEDGE_MANIFEST_PATH ?? "unused-by-web-submission",
    objectStore: getKnowledgeObjectStore(),
    sourceRoots: {},
  });
  return globalImport.culiuKnowledgeImporter;
}

export async function publishKnowledgeSubmission(
  actorUserId: string,
  loaded: LoadedKnowledgeImport,
): Promise<KnowledgeImportResult> {
  const current = await getDatabaseClient().pool.query<{ corpus_hash: string }>(
    "select corpus_hash from knowledge_import_batch where is_current = true and status = 'published' limit 1",
  );
  const publicationHash = createHash("sha256")
    .update(
      `upsert:${current.rows[0]?.corpus_hash ?? "empty"}:${loaded.manifest.corpus_hash}`,
      "utf8",
    )
    .digest("hex");
  return getKnowledgeImporter().importLoaded(
    {
      actorUserId,
      corpusHash: publicationHash,
      corpusId: "culiu_knowledge_publication_v1",
      expectedLectureCount: loaded.manifest.expected_lecture_count,
      manifestVersion: loaded.manifest.manifest_version,
      mappingVersion: loaded.manifest.mapping_version,
      publicationMode: "upsert",
    },
    loaded,
  );
}
