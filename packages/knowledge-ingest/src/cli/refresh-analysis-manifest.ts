import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { contentSha256 } from "../analysis-documents.js";
import { KnowledgeSourceManifestSchema } from "../contracts.js";
import {
  computeKnowledgeBundleHash,
  computeKnowledgeCorpusHash,
  verifyKnowledgeSourceManifest,
} from "../manifest.js";
import { INDEX_MAPPINGS } from "../mappings.js";
import { parseAnalysisMarkdown } from "../source-parsers.js";

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, "../../../..");
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      "analysis-root": { type: "string" },
      manifest: {
        default: join(repositoryRoot, "knowledge", "source-manifest.v1.json"),
        type: "string",
      },
      output: {
        default: join(repositoryRoot, "knowledge", "source-manifest.v1.json"),
        type: "string",
      },
    },
    strict: true,
  });
  if (parsed.values["analysis-root"] === undefined) {
    throw new Error("--analysis-root is required.");
  }
  const analysisRoot = resolve(parsed.values["analysis-root"]);
  const manifestPath = resolve(parsed.values.manifest);
  const current = KnowledgeSourceManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const lectures = [];
  for (const lecture of current.lectures) {
    const analysisSource = lecture.sources.find((source) => source.role === "analysis_markdown");
    if (analysisSource === undefined)
      throw new Error(`${lecture.source_key}: analysis source missing`);
    const bytes = await readFile(join(analysisRoot, analysisSource.relative_path));
    const metadata = parseAnalysisMarkdown(bytes.toString("utf8"), analysisSource.relative_path);
    const sources = lecture.sources.map((source) =>
      source.role === "analysis_markdown"
        ? {
            ...source,
            bytes: bytes.byteLength,
            content_sha256: contentSha256(bytes),
          }
        : source,
    );
    lectures.push({
      ...lecture,
      analysis_sections: metadata.sections,
      bundle_hash: computeKnowledgeBundleHash(sources),
      sources,
      title: metadata.title,
    });
  }
  const next = KnowledgeSourceManifestSchema.parse({
    ...current,
    corpus_hash: computeKnowledgeCorpusHash(lectures),
    index_mappings: INDEX_MAPPINGS,
    lectures,
  });
  verifyKnowledgeSourceManifest(next);
  await writeFile(resolve(parsed.values.output), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ corpus_hash: next.corpus_hash, lecture_count: next.lecture_count })}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown manifest refresh failure";
  process.stderr.write(`Knowledge analysis manifest refresh failed: ${message}\n`);
  process.exitCode = 1;
}
