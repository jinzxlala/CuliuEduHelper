import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { z } from "zod";

import {
  KNOWLEDGE_CORPUS_ID,
  KNOWLEDGE_MAPPING_VERSION,
  KNOWLEDGE_SOURCE_MANIFEST_VERSION,
  KnowledgeSourceManifestSchema,
  SOURCE_ROLES,
  SourceRoleSchema,
  type KnowledgeSourceManifest,
  type LectureSourceBundle,
  type SourceFile,
  type SourceRole,
} from "./contracts.js";
import { KnowledgeSourceError } from "./errors.js";
import { INDEX_MAPPINGS, SOURCE_POLICIES } from "./mappings.js";
import {
  decodeUtf8,
  parseAnalysisMarkdown,
  validateTranscriptRepresentations,
} from "./source-parsers.js";

const SOURCE_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})_(.+)$/u;
const TRANSCRIPT_FILE_PATTERN = /^(.+?)(\.qa)?\.(json|srt|txt)$/u;
const ALLOWED_NON_LECTURE_FILES = new Map([
  ["_整理汇总.json", "aggregate_not_primary_source" as const],
]);

const MIME_TYPES: Readonly<Record<SourceRole, SourceFile["mime_type"]>> = {
  analysis_markdown: "text/markdown",
  transcript_json: "application/json",
  transcript_qa: "application/json",
  transcript_srt: "application/x-subrip",
  transcript_text: "text/plain",
};

interface LocatedSource {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly role: SourceRole;
  readonly rootId: string;
}

interface LocatedTranscriptSet {
  readonly lectureYear: number;
  readonly sources: Map<SourceRole, LocatedSource>;
}

export interface TranscriptRootInput {
  readonly lectureYear: number;
  readonly path: string;
}

export interface BuildKnowledgeManifestOptions {
  readonly analysisRoot: string;
  readonly transcriptRoots: readonly TranscriptRootInput[];
}

export interface WriteKnowledgeManifestOptions extends BuildKnowledgeManifestOptions {
  readonly outputPath: string;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function sourceKeyMetadata(sourceKey: string): { readonly date: string; readonly year: number } {
  const match = SOURCE_KEY_PATTERN.exec(sourceKey);
  if (match === null || match[1] === undefined || match[2]?.trim() === "") {
    throw new KnowledgeSourceError(
      "invalid_source",
      `${sourceKey}: source filename must use YYYY-MM-DD_<title>`,
    );
  }
  const date = z.iso.date().safeParse(match[1]);
  if (!date.success) {
    throw new KnowledgeSourceError("invalid_source", `${sourceKey}: filename date is invalid`);
  }
  return { date: date.data, year: Number(date.data.slice(0, 4)) };
}

function transcriptRole(fileName: string): {
  readonly role: SourceRole;
  readonly sourceKey: string;
} {
  const match = TRANSCRIPT_FILE_PATTERN.exec(fileName);
  if (match === null || match[1] === undefined || match[3] === undefined) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      `${fileName}: unexpected file in a transcript source root`,
    );
  }
  const sourceKey = match[1];
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      `${fileName}: transcript source filename must use YYYY-MM-DD_<title>`,
    );
  }
  sourceKeyMetadata(sourceKey);
  if (match[2] !== undefined) {
    return { role: "transcript_qa", sourceKey };
  }
  const role = {
    json: "transcript_json",
    srt: "transcript_srt",
    txt: "transcript_text",
  }[match[3]];
  return { role: SourceRoleSchema.parse(role), sourceKey };
}

export function knowledgeLogicalPath(sourceKey: string, role: SourceRole): string {
  const { year } = sourceKeyMetadata(sourceKey);
  const extension = {
    analysis_markdown: ".md",
    transcript_json: ".json",
    transcript_qa: ".qa.json",
    transcript_srt: ".srt",
    transcript_text: ".txt",
  }[role];
  if (role === "analysis_markdown") {
    return `knowledge/analysis/${sourceKey}${extension}`;
  }
  return `knowledge/transcripts/${String(year)}/${sourceKey}${extension}`;
}

export function knowledgeLectureId(sourceKey: string): string {
  const { date } = sourceKeyMetadata(sourceKey);
  return `lecture_${date.replaceAll("-", "")}_${sha256(sourceKey).slice(0, 12)}`;
}

export function computeKnowledgeBundleHash(sources: readonly SourceFile[]): string {
  return canonicalHash(
    sources.map((source) => ({ role: source.role, sha256: source.content_sha256 })),
  );
}

export function computeKnowledgeCorpusHash(lectures: readonly LectureSourceBundle[]): string {
  return canonicalHash(
    lectures.map((lecture) => ({
      bundle_hash: lecture.bundle_hash,
      source_key: lecture.source_key,
    })),
  );
}

async function listFiles(rootPath: string, rootLabel: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    throw new KnowledgeSourceError(
      "invalid_configuration",
      `${rootLabel}: cannot read source root`,
      { cause: error },
    );
  }
  const nonFiles = entries.filter((entry) => !entry.isFile());
  if (nonFiles.length > 0) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      `${rootLabel}: source roots must be flat; found ${nonFiles[0]?.name ?? "non-file entry"}`,
    );
  }
  return entries.map((entry) => entry.name).sort(compareStrings);
}

async function locateAnalysisSources(rootPath: string): Promise<Map<string, LocatedSource>> {
  const files = await listFiles(rootPath, "analysis root");
  const result = new Map<string, LocatedSource>();
  for (const fileName of files) {
    if (extname(fileName).toLowerCase() !== ".md") {
      throw new KnowledgeSourceError(
        "unexpected_source",
        `${fileName}: analysis root may contain only Markdown source files`,
      );
    }
    const sourceKey = basename(fileName, ".md");
    sourceKeyMetadata(sourceKey);
    if (result.has(sourceKey)) {
      throw new KnowledgeSourceError("duplicate_source", `${sourceKey}: duplicate analysis source`);
    }
    result.set(sourceKey, {
      absolutePath: join(rootPath, fileName),
      relativePath: fileName,
      role: "analysis_markdown",
      rootId: "analysis",
    });
  }
  return result;
}

async function locateTranscriptSources(roots: readonly TranscriptRootInput[]): Promise<{
  readonly excludedFiles: KnowledgeSourceManifest["excluded_files"];
  readonly sets: Map<string, LocatedTranscriptSet>;
}> {
  if (roots.length === 0) {
    throw new KnowledgeSourceError(
      "invalid_configuration",
      "at least one transcript root is required",
    );
  }
  const years = roots.map((root) => root.lectureYear);
  if (new Set(years).size !== years.length) {
    throw new KnowledgeSourceError(
      "invalid_configuration",
      "transcript root lecture years must be unique",
    );
  }

  const sets = new Map<string, LocatedTranscriptSet>();
  const excludedFiles: KnowledgeSourceManifest["excluded_files"] = [];
  for (const root of [...roots].sort((left, right) => left.lectureYear - right.lectureYear)) {
    if (!Number.isInteger(root.lectureYear) || root.lectureYear < 2000 || root.lectureYear > 2100) {
      throw new KnowledgeSourceError(
        "invalid_configuration",
        `invalid transcript root year: ${String(root.lectureYear)}`,
      );
    }
    const rootId = `transcripts_${String(root.lectureYear)}`;
    const files = await listFiles(root.path, rootId);
    for (const fileName of files) {
      const excludedReason = ALLOWED_NON_LECTURE_FILES.get(fileName);
      if (excludedReason !== undefined) {
        excludedFiles.push({ reason: excludedReason, relative_path: fileName, root_id: rootId });
        continue;
      }
      const { role, sourceKey } = transcriptRole(fileName);
      const { year } = sourceKeyMetadata(sourceKey);
      if (year !== root.lectureYear) {
        throw new KnowledgeSourceError(
          "invalid_source",
          `${fileName}: lecture year does not match transcript root ${String(root.lectureYear)}`,
        );
      }
      let set = sets.get(sourceKey);
      if (set === undefined) {
        set = { lectureYear: root.lectureYear, sources: new Map() };
        sets.set(sourceKey, set);
      } else if (set.lectureYear !== root.lectureYear) {
        throw new KnowledgeSourceError(
          "duplicate_source",
          `${sourceKey}: transcript source appears in more than one root`,
        );
      }
      if (set.sources.has(role)) {
        throw new KnowledgeSourceError(
          "duplicate_source",
          `${sourceKey}: duplicate ${role} source`,
        );
      }
      set.sources.set(role, {
        absolutePath: join(root.path, fileName),
        relativePath: fileName,
        role,
        rootId,
      });
    }
  }

  return {
    excludedFiles: excludedFiles.sort((left, right) =>
      compareStrings(
        `${left.root_id}/${left.relative_path}`,
        `${right.root_id}/${right.relative_path}`,
      ),
    ),
    sets,
  };
}

function requireLocatedSource(
  sources: ReadonlyMap<SourceRole, LocatedSource>,
  role: SourceRole,
  sourceKey: string,
): LocatedSource {
  const source = sources.get(role);
  if (source === undefined) {
    throw new KnowledgeSourceError("missing_source", `${sourceKey}: missing ${role} source`);
  }
  return source;
}

async function describeSource(
  sourceKey: string,
  source: LocatedSource,
): Promise<{
  readonly descriptor: SourceFile;
  readonly text: string;
}> {
  const bytes = await readFile(source.absolutePath);
  if (bytes.byteLength === 0) {
    throw new KnowledgeSourceError(
      "invalid_source",
      `${source.relativePath}: source file is empty`,
    );
  }
  return {
    descriptor: {
      bytes: bytes.byteLength,
      content_sha256: sha256(bytes),
      logical_path: knowledgeLogicalPath(sourceKey, source.role),
      mime_type: MIME_TYPES[source.role],
      relative_path: source.relativePath.replaceAll("\\", "/"),
      role: source.role,
      root_id: source.rootId,
    },
    text: decodeUtf8(bytes, source.relativePath),
  };
}

async function buildLectureBundle(
  sourceKey: string,
  analysisSource: LocatedSource,
  transcriptSet: LocatedTranscriptSet,
): Promise<LectureSourceBundle> {
  const analysis = await describeSource(sourceKey, analysisSource);
  const transcriptJson = await describeSource(
    sourceKey,
    requireLocatedSource(transcriptSet.sources, "transcript_json", sourceKey),
  );
  const transcriptQa = await describeSource(
    sourceKey,
    requireLocatedSource(transcriptSet.sources, "transcript_qa", sourceKey),
  );
  const transcriptSrt = await describeSource(
    sourceKey,
    requireLocatedSource(transcriptSet.sources, "transcript_srt", sourceKey),
  );
  const transcriptText = await describeSource(
    sourceKey,
    requireLocatedSource(transcriptSet.sources, "transcript_text", sourceKey),
  );

  const analysisMetadata = parseAnalysisMarkdown(analysis.text, analysisSource.relativePath);
  const transcriptMetadata = validateTranscriptRepresentations({
    json: transcriptJson.text,
    jsonLabel: transcriptJson.descriptor.relative_path,
    qa: transcriptQa.text,
    qaLabel: transcriptQa.descriptor.relative_path,
    srt: transcriptSrt.text,
    srtLabel: transcriptSrt.descriptor.relative_path,
    text: transcriptText.text,
    textLabel: transcriptText.descriptor.relative_path,
  });
  const sources = [
    analysis.descriptor,
    transcriptJson.descriptor,
    transcriptQa.descriptor,
    transcriptSrt.descriptor,
    transcriptText.descriptor,
  ];
  const { date } = sourceKeyMetadata(sourceKey);

  return {
    analysis_sections: analysisMetadata.sections,
    bundle_hash: computeKnowledgeBundleHash(sources),
    lecture_date: date,
    lecture_id: knowledgeLectureId(sourceKey),
    source_key: sourceKey,
    sources,
    title: analysisMetadata.title,
    transcript_validation: {
      changed_sentence_count: transcriptMetadata.changedSentenceCount,
      duration_seconds: transcriptMetadata.durationSeconds,
      sentence_count: transcriptMetadata.sentenceCount,
      srt_cue_count: transcriptMetadata.srtCueCount,
      text_line_count: transcriptMetadata.textLineCount,
    },
  };
}

function assertSameSourceKeys(
  analysisSources: ReadonlyMap<string, LocatedSource>,
  transcriptSets: ReadonlyMap<string, LocatedTranscriptSet>,
): void {
  const missingTranscripts = [...analysisSources.keys()].filter((key) => !transcriptSets.has(key));
  const missingAnalyses = [...transcriptSets.keys()].filter((key) => !analysisSources.has(key));
  if (missingTranscripts.length > 0 || missingAnalyses.length > 0) {
    throw new KnowledgeSourceError(
      "source_set_mismatch",
      `analysis/transcript source keys differ (missing transcript sets: ${String(missingTranscripts.length)}; missing analyses: ${String(missingAnalyses.length)})`,
    );
  }
}

export function verifyKnowledgeSourceManifest(value: unknown): KnowledgeSourceManifest {
  const manifest = KnowledgeSourceManifestSchema.parse(value);
  if (JSON.stringify(manifest.source_policies) !== JSON.stringify(SOURCE_POLICIES)) {
    throw new KnowledgeSourceError("invalid_source", "manifest source policies have drifted");
  }
  if (JSON.stringify(manifest.index_mappings) !== JSON.stringify(INDEX_MAPPINGS)) {
    throw new KnowledgeSourceError("invalid_source", "manifest index mappings have drifted");
  }
  const sortedSourceKeys = [...manifest.lectures.map((lecture) => lecture.source_key)].sort(
    compareStrings,
  );
  if (
    JSON.stringify(sortedSourceKeys) !==
    JSON.stringify(manifest.lectures.map((item) => item.source_key))
  ) {
    throw new KnowledgeSourceError("invalid_source", "manifest lectures are not canonical-sorted");
  }
  for (const lecture of manifest.lectures) {
    if (lecture.bundle_hash !== computeKnowledgeBundleHash(lecture.sources)) {
      throw new KnowledgeSourceError(
        "invalid_source",
        `${lecture.source_key}: bundle hash does not match source hashes`,
      );
    }
    if (lecture.lecture_id !== knowledgeLectureId(lecture.source_key)) {
      throw new KnowledgeSourceError(
        "invalid_source",
        `${lecture.source_key}: lecture ID is not deterministic`,
      );
    }
    if (
      JSON.stringify(lecture.sources.map((source) => source.role)) !== JSON.stringify(SOURCE_ROLES)
    ) {
      throw new KnowledgeSourceError(
        "invalid_source",
        `${lecture.source_key}: source roles are not canonical-sorted`,
      );
    }
  }
  if (manifest.corpus_hash !== computeKnowledgeCorpusHash(manifest.lectures)) {
    throw new KnowledgeSourceError("invalid_source", "corpus hash does not match lecture bundles");
  }
  return manifest;
}

export async function buildKnowledgeSourceManifest(
  options: BuildKnowledgeManifestOptions,
): Promise<KnowledgeSourceManifest> {
  const analysisSources = await locateAnalysisSources(options.analysisRoot);
  const { excludedFiles, sets: transcriptSets } = await locateTranscriptSources(
    options.transcriptRoots,
  );
  assertSameSourceKeys(analysisSources, transcriptSets);
  if (analysisSources.size === 0) {
    throw new KnowledgeSourceError(
      "source_set_mismatch",
      "at least one lecture source is required",
    );
  }

  const lectures: LectureSourceBundle[] = [];
  for (const sourceKey of [...analysisSources.keys()].sort(compareStrings)) {
    const analysisSource = analysisSources.get(sourceKey);
    const transcriptSet = transcriptSets.get(sourceKey);
    if (analysisSource === undefined || transcriptSet === undefined) {
      throw new KnowledgeSourceError(
        "source_set_mismatch",
        `${sourceKey}: source pair disappeared during manifest generation`,
      );
    }
    lectures.push(await buildLectureBundle(sourceKey, analysisSource, transcriptSet));
  }

  const transcriptYears = [...options.transcriptRoots]
    .map((root) => root.lectureYear)
    .sort((left, right) => left - right);
  const manifest: KnowledgeSourceManifest = {
    boundary_rules: {
      manifest_contains_body_content: false,
      manifest_purpose: "verified_inventory_import_entrypoint",
      raw_embedded_paths_are_excluded: true,
      source_files_read_only: true,
      student_data_allowed: false,
    },
    builder_version: "0.1.0",
    corpus_hash: computeKnowledgeCorpusHash(lectures),
    corpus_id: KNOWLEDGE_CORPUS_ID,
    excluded_files: excludedFiles,
    expected_lecture_count: lectures.length,
    index_mappings: INDEX_MAPPINGS,
    lecture_count: lectures.length,
    lectures,
    manifest_version: KNOWLEDGE_SOURCE_MANIFEST_VERSION,
    mapping_version: KNOWLEDGE_MAPPING_VERSION,
    source_policies: SOURCE_POLICIES,
    source_roots: [
      {
        lecture_year: null,
        root_id: "analysis",
        source_roles: ["analysis_markdown"],
      },
      ...transcriptYears.map((year) => ({
        lecture_year: year,
        root_id: `transcripts_${String(year)}`,
        source_roles: [
          "transcript_json" as const,
          "transcript_qa" as const,
          "transcript_srt" as const,
          "transcript_text" as const,
        ],
      })),
    ],
  };
  return verifyKnowledgeSourceManifest(manifest);
}

export function serializeKnowledgeSourceManifest(manifest: KnowledgeSourceManifest): string {
  return `${JSON.stringify(verifyKnowledgeSourceManifest(manifest), null, 2)}\n`;
}

export async function writeKnowledgeSourceManifest(
  options: WriteKnowledgeManifestOptions,
): Promise<KnowledgeSourceManifest> {
  const manifest = await buildKnowledgeSourceManifest(options);
  const outputDirectory = dirname(options.outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = `${options.outputPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeKnowledgeSourceManifest(manifest), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, options.outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return manifest;
}
