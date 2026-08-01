import { readFile } from "node:fs/promises";

import { z } from "zod";

import { loadKnowledgeImport } from "../source-loader.js";
import { verifyKnowledgeSourceManifest } from "../manifest.js";

const EnvironmentSchema = z.object({
  KNOWLEDGE_ANALYSIS_ROOT: z.string().min(1),
  KNOWLEDGE_MANIFEST_PATH: z.string().min(1),
  KNOWLEDGE_TRANSCRIPT_2025_ROOT: z.string().min(1),
  KNOWLEDGE_TRANSCRIPT_2026_ROOT: z.string().min(1),
});

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const manifest = verifyKnowledgeSourceManifest(
    JSON.parse(await readFile(environment.KNOWLEDGE_MANIFEST_PATH, "utf8")) as unknown,
  );
  const loaded = await loadKnowledgeImport({
    expectedCorpusHash: manifest.corpus_hash,
    expectedCorpusId: manifest.corpus_id,
    expectedManifestVersion: manifest.manifest_version,
    expectedMappingVersion: manifest.mapping_version,
    manifestPath: environment.KNOWLEDGE_MANIFEST_PATH,
    sourceRoots: {
      analysis: environment.KNOWLEDGE_ANALYSIS_ROOT,
      transcripts_2025: environment.KNOWLEDGE_TRANSCRIPT_2025_ROOT,
      transcripts_2026: environment.KNOWLEDGE_TRANSCRIPT_2026_ROOT,
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      cases: loaded.documents.cases.length,
      corpusHash: loaded.manifest.corpus_hash,
      lectures: loaded.documents.lectures.length,
      sources: loaded.sources.length,
      transcriptSegments: loaded.documents.transcriptSegments.length,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Knowledge input validation failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
