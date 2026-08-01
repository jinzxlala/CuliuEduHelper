import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { KnowledgeDocumentSet } from "@culiu/search";

import {
  type KnowledgeSourceManifest,
  type LectureSourceBundle,
  type SourceFile,
  type SourceRole,
} from "./contracts.js";
import {
  buildKnowledgeDocumentSet,
  contentSha256,
  parseAnalysisDocuments,
  type ParsedAnalysisDocuments,
} from "./analysis-documents.js";
import { KnowledgeImportError } from "./import-errors.js";
import { verifyKnowledgeSourceManifest } from "./manifest.js";
import { decodeUtf8, validateTranscriptRepresentations } from "./source-parsers.js";

export type SourceRootMap = Readonly<Record<string, string>>;

export interface LoadedKnowledgeSource {
  readonly bundle: LectureSourceBundle;
  readonly bytes: Uint8Array;
  readonly descriptor: SourceFile;
}

export interface LoadedKnowledgeImport {
  readonly documents: KnowledgeDocumentSet;
  readonly manifest: KnowledgeSourceManifest;
  readonly sources: readonly LoadedKnowledgeSource[];
}

export interface LoadKnowledgeImportOptions {
  readonly expectedCorpusHash: string;
  readonly expectedCorpusId: string;
  readonly expectedManifestVersion: string;
  readonly expectedMappingVersion: string;
  readonly manifestPath: string;
  readonly sourceRoots: SourceRootMap;
}

function parseManifest(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      "Knowledge manifest is not valid JSON.",
      { cause: error },
    );
  }
}

function assertManifestIdentity(
  manifest: KnowledgeSourceManifest,
  options: LoadKnowledgeImportOptions,
): void {
  if (
    manifest.corpus_hash !== options.expectedCorpusHash ||
    manifest.corpus_id !== options.expectedCorpusId ||
    manifest.manifest_version !== options.expectedManifestVersion ||
    manifest.mapping_version !== options.expectedMappingVersion
  ) {
    throw new KnowledgeImportError(
      "manifest_identity_mismatch",
      "validation",
      "Knowledge manifest identity does not match the queued import request.",
    );
  }
}

function sourcePath(rootPath: string, descriptor: SourceFile): string {
  if (!isAbsolute(rootPath)) {
    throw new KnowledgeImportError(
      "source_read_failed",
      "validation",
      `Source root ${descriptor.root_id} must be an absolute server-side path.`,
      { sourceRole: descriptor.role },
    );
  }
  const root = resolve(rootPath);
  const target = resolve(root, ...descriptor.relative_path.split("/"));
  const relativePath = relative(root, target);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new KnowledgeImportError(
      "source_read_failed",
      "validation",
      `${descriptor.logical_path}: source path escaped its configured root.`,
      { sourceRole: descriptor.role },
    );
  }
  return target;
}

async function loadSource(
  bundle: LectureSourceBundle,
  descriptor: SourceFile,
  roots: SourceRootMap,
): Promise<LoadedKnowledgeSource> {
  const root = roots[descriptor.root_id];
  if (root === undefined) {
    throw new KnowledgeImportError(
      "source_read_failed",
      "validation",
      `${descriptor.logical_path}: no server-side source root is configured.`,
      { sourceKey: bundle.source_key, sourceRole: descriptor.role },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(sourcePath(root, descriptor));
  } catch (error) {
    if (error instanceof KnowledgeImportError) throw error;
    throw new KnowledgeImportError(
      "source_read_failed",
      "validation",
      `${descriptor.logical_path}: source file could not be read.`,
      { cause: error, sourceKey: bundle.source_key, sourceRole: descriptor.role },
    );
  }
  if (bytes.byteLength !== descriptor.bytes || contentSha256(bytes) !== descriptor.content_sha256) {
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      `${descriptor.logical_path}: source bytes do not match the verified manifest.`,
      { sourceKey: bundle.source_key, sourceRole: descriptor.role },
    );
  }
  return { bundle, bytes, descriptor };
}

function requireRole(
  sources: ReadonlyMap<SourceRole, LoadedKnowledgeSource>,
  role: SourceRole,
  bundle: LectureSourceBundle,
): LoadedKnowledgeSource {
  const source = sources.get(role);
  if (source === undefined) {
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      `${bundle.source_key}: verified bundle is missing ${role}.`,
      { sourceKey: bundle.source_key, sourceRole: role },
    );
  }
  return source;
}

function sourceText(source: LoadedKnowledgeSource): string {
  try {
    return decodeUtf8(source.bytes, source.descriptor.logical_path);
  } catch (error) {
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      `${source.descriptor.logical_path}: source is not valid UTF-8.`,
      {
        cause: error,
        sourceKey: source.bundle.source_key,
        sourceRole: source.descriptor.role,
      },
    );
  }
}

export async function loadKnowledgeImport(
  options: LoadKnowledgeImportOptions,
): Promise<LoadedKnowledgeImport> {
  let manifestText: string;
  try {
    manifestText = await readFile(options.manifestPath, "utf8");
  } catch (error) {
    throw new KnowledgeImportError(
      "source_read_failed",
      "validation",
      "Knowledge manifest could not be read.",
      { cause: error },
    );
  }

  let manifest: KnowledgeSourceManifest;
  try {
    manifest = verifyKnowledgeSourceManifest(parseManifest(manifestText));
  } catch (error) {
    if (error instanceof KnowledgeImportError) throw error;
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      "Knowledge manifest failed schema or canonical integrity validation.",
      { cause: error },
    );
  }
  assertManifestIdentity(manifest, options);

  const allSources: LoadedKnowledgeSource[] = [];
  const parsedAnalyses: ParsedAnalysisDocuments[] = [];
  for (const bundle of manifest.lectures) {
    const loaded = await Promise.all(
      bundle.sources.map(async (descriptor) => loadSource(bundle, descriptor, options.sourceRoots)),
    );
    const byRole = new Map(loaded.map((source) => [source.descriptor.role, source]));
    const analysis = requireRole(byRole, "analysis_markdown", bundle);
    const transcriptJson = requireRole(byRole, "transcript_json", bundle);
    const transcriptQa = requireRole(byRole, "transcript_qa", bundle);
    const transcriptSrt = requireRole(byRole, "transcript_srt", bundle);
    const transcriptText = requireRole(byRole, "transcript_text", bundle);

    try {
      validateTranscriptRepresentations({
        json: sourceText(transcriptJson),
        jsonLabel: transcriptJson.descriptor.logical_path,
        qa: sourceText(transcriptQa),
        qaLabel: transcriptQa.descriptor.logical_path,
        srt: sourceText(transcriptSrt),
        srtLabel: transcriptSrt.descriptor.logical_path,
        text: sourceText(transcriptText),
        textLabel: transcriptText.descriptor.logical_path,
      });
      parsedAnalyses.push(
        parseAnalysisDocuments(sourceText(analysis), bundle, analysis.descriptor.logical_path),
      );
    } catch (error) {
      if (error instanceof KnowledgeImportError) throw error;
      throw new KnowledgeImportError(
        "source_integrity_failed",
        "validation",
        `${bundle.source_key}: source bundle validation failed.`,
        { cause: error, sourceKey: bundle.source_key },
      );
    }
    allSources.push(...loaded);
  }

  const documents = buildKnowledgeDocumentSet(parsedAnalyses);
  if (documents.lectures.length !== manifest.expected_lecture_count) {
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      "Parsed lecture count does not match the manifest gate.",
    );
  }
  if (documents.transcriptSegments.length !== 0) {
    throw new KnowledgeImportError(
      "source_integrity_failed",
      "validation",
      "Transcript publication is blocked until privacy review and anonymization are implemented.",
    );
  }

  return { documents, manifest, sources: allSources };
}
