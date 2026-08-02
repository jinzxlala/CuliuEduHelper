import { basename } from "node:path";

import { KnowledgeDocumentSetSchema } from "@culiu/search";

import {
  KNOWLEDGE_MAPPING_VERSION,
  KNOWLEDGE_SOURCE_MANIFEST_VERSION,
  KnowledgeSourceManifestSchema,
  LectureSourceBundleSchema,
  type SourceFile,
  type SourceRole,
} from "./contracts.js";
import { contentSha256, parseAnalysisDocuments } from "./analysis-documents.js";
import { KnowledgeSourceError } from "./errors.js";
import {
  computeKnowledgeBundleHash,
  computeKnowledgeCorpusHash,
  knowledgeLectureId,
  knowledgeLogicalPath,
} from "./manifest.js";
import { INDEX_MAPPINGS, SOURCE_POLICIES } from "./mappings.js";
import type { LoadedKnowledgeImport, LoadedKnowledgeSource } from "./source-loader.js";
import {
  decodeUtf8,
  parseAnalysisMarkdown,
  validateTranscriptRepresentations,
} from "./source-parsers.js";

export const MAX_KNOWLEDGE_SUBMISSION_BYTES = 20 * 1024 * 1024;
const SOURCE_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})_(.+)$/u;

export interface SubmittedKnowledgeFile {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

export interface KnowledgeSubmissionInput {
  readonly analysis: SubmittedKnowledgeFile;
  readonly transcriptDocument?: SubmittedKnowledgeFile;
  readonly transcriptJson?: SubmittedKnowledgeFile;
  readonly transcriptQa?: SubmittedKnowledgeFile;
  readonly transcriptSrt?: SubmittedKnowledgeFile;
  readonly transcriptText?: SubmittedKnowledgeFile;
}

function safeFileName(fileName: string): string {
  if (basename(fileName) !== fileName || fileName.includes("\\") || fileName.includes("/")) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "uploaded file names must not contain paths",
    );
  }
  return fileName;
}

function sourceKeyFromAnalysis(fileName: string): string {
  const safe = safeFileName(fileName);
  if (!safe.endsWith(".md")) {
    throw new KnowledgeSourceError("unexpected_source", "analysis file must use the .md extension");
  }
  const sourceKey = safe.slice(0, -3);
  const match = SOURCE_KEY_PATTERN.exec(sourceKey);
  const datePart = match?.[1];
  const titlePart = match?.[2];
  if (datePart === undefined || titlePart === undefined || titlePart.trim() === "") {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "analysis file name must follow YYYY-MM-DD_title.md",
    );
  }
  const parsedDate = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== datePart) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "analysis file name contains an invalid date",
    );
  }
  return sourceKey;
}

function descriptor(sourceKey: string, role: SourceRole, file: SubmittedKnowledgeFile): SourceFile {
  const extension = {
    analysis_markdown: ".md",
    transcript_json: ".json",
    transcript_qa: ".qa.json",
    transcript_srt: ".srt",
    transcript_text: ".txt",
  }[role];
  const expectedName = `${sourceKey}${extension}`;
  if (safeFileName(file.fileName) !== expectedName) {
    throw new KnowledgeSourceError("unexpected_source", `${role} must be named ${expectedName}`);
  }
  if (file.bytes.byteLength === 0) {
    throw new KnowledgeSourceError("invalid_source", `${file.fileName}: file is empty`);
  }
  return {
    bytes: file.bytes.byteLength,
    content_sha256: contentSha256(file.bytes),
    logical_path: knowledgeLogicalPath(sourceKey, role),
    mime_type: (
      {
        analysis_markdown: "text/markdown",
        transcript_json: "application/json",
        transcript_qa: "application/json",
        transcript_srt: "application/x-subrip",
        transcript_text: "text/plain",
      } as const
    )[role],
    relative_path: file.fileName,
    role,
    root_id: role === "analysis_markdown" ? "submission_analysis" : "submission_transcript",
  };
}

function transcriptDocumentDescriptor(sourceKey: string, file: SubmittedKnowledgeFile): SourceFile {
  const safe = safeFileName(file.fileName);
  const extension = safe.endsWith(".docx") ? ".docx" : safe.endsWith(".md") ? ".md" : null;
  if (extension === null || safe !== `${sourceKey}${extension}`) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      `transcript document must be named ${sourceKey}.md or ${sourceKey}.docx`,
    );
  }
  if (file.bytes.byteLength === 0) {
    throw new KnowledgeSourceError("invalid_source", `${file.fileName}: file is empty`);
  }
  return {
    bytes: file.bytes.byteLength,
    content_sha256: contentSha256(file.bytes),
    logical_path: `knowledge/transcripts/${sourceKey.slice(0, 4)}/${sourceKey}${extension}`,
    mime_type:
      extension === ".md"
        ? "text/markdown"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    relative_path: file.fileName,
    role: "transcript_text",
    root_id: "submission_transcript_document",
  };
}

export function buildKnowledgeSubmission(input: KnowledgeSubmissionInput): LoadedKnowledgeImport {
  const sourceKey = sourceKeyFromAnalysis(input.analysis.fileName);
  const transcriptFiles = [
    input.transcriptJson,
    input.transcriptQa,
    input.transcriptSrt,
    input.transcriptText,
  ];
  const suppliedTranscriptCount = transcriptFiles.filter((file) => file !== undefined).length;
  if (input.transcriptDocument !== undefined && suppliedTranscriptCount !== 0) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "a transcript document cannot be combined with the legacy four-file evidence package",
    );
  }
  if (suppliedTranscriptCount !== 0 && suppliedTranscriptCount !== 4) {
    throw new KnowledgeSourceError(
      "missing_source",
      "a complete evidence package requires JSON, QA JSON, SRT and timestamped TXT",
    );
  }
  const files = [input.analysis, input.transcriptDocument, ...transcriptFiles].filter(
    (file): file is SubmittedKnowledgeFile => file !== undefined,
  );
  if (
    files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_KNOWLEDGE_SUBMISSION_BYTES
  ) {
    throw new KnowledgeSourceError("invalid_source", "knowledge submission exceeds 20 MB");
  }

  const analysisText = decodeUtf8(input.analysis.bytes, input.analysis.fileName);
  const analysisMetadata = parseAnalysisMarkdown(analysisText, input.analysis.fileName);
  const sources: Array<{ descriptor: SourceFile; file: SubmittedKnowledgeFile }> = [
    {
      descriptor: descriptor(sourceKey, "analysis_markdown", input.analysis),
      file: input.analysis,
    },
  ];
  if (input.transcriptDocument !== undefined) {
    sources.push({
      descriptor: transcriptDocumentDescriptor(sourceKey, input.transcriptDocument),
      file: input.transcriptDocument,
    });
  }
  let transcriptValidation = null;
  if (
    input.transcriptJson !== undefined &&
    input.transcriptQa !== undefined &&
    input.transcriptSrt !== undefined &&
    input.transcriptText !== undefined
  ) {
    const values = [
      ["transcript_json", input.transcriptJson],
      ["transcript_qa", input.transcriptQa],
      ["transcript_srt", input.transcriptSrt],
      ["transcript_text", input.transcriptText],
    ] as const;
    for (const [role, file] of values) {
      sources.push({ descriptor: descriptor(sourceKey, role, file), file });
    }
    const validated = validateTranscriptRepresentations({
      json: decodeUtf8(input.transcriptJson.bytes, input.transcriptJson.fileName),
      jsonLabel: input.transcriptJson.fileName,
      qa: decodeUtf8(input.transcriptQa.bytes, input.transcriptQa.fileName),
      qaLabel: input.transcriptQa.fileName,
      srt: decodeUtf8(input.transcriptSrt.bytes, input.transcriptSrt.fileName),
      srtLabel: input.transcriptSrt.fileName,
      text: decodeUtf8(input.transcriptText.bytes, input.transcriptText.fileName),
      textLabel: input.transcriptText.fileName,
    });
    transcriptValidation = {
      changed_sentence_count: validated.changedSentenceCount,
      duration_seconds: validated.durationSeconds,
      sentence_count: validated.sentenceCount,
      srt_cue_count: validated.srtCueCount,
      text_line_count: validated.textLineCount,
    };
  }
  const sourceDescriptors = sources.map((source) => source.descriptor);
  const bundle = LectureSourceBundleSchema.parse({
    analysis_sections: analysisMetadata.sections,
    bundle_hash: computeKnowledgeBundleHash(sourceDescriptors),
    lecture_date: sourceKey.slice(0, 10),
    lecture_id: knowledgeLectureId(sourceKey),
    source_key: sourceKey,
    sources: sourceDescriptors,
    title: analysisMetadata.title,
    transcript_validation: transcriptValidation,
  });
  const parsed = parseAnalysisDocuments(analysisText, bundle, input.analysis.fileName);
  const manifest = KnowledgeSourceManifestSchema.parse({
    boundary_rules: {
      manifest_contains_body_content: false,
      manifest_purpose: "verified_inventory_import_entrypoint",
      raw_embedded_paths_are_excluded: true,
      source_files_read_only: true,
      student_data_allowed: false,
    },
    builder_version: "0.1.0",
    corpus_hash: computeKnowledgeCorpusHash([bundle]),
    corpus_id: "culiu_knowledge_submission_v1",
    excluded_files: [],
    expected_lecture_count: 1,
    index_mappings: INDEX_MAPPINGS,
    lecture_count: 1,
    lectures: [bundle],
    manifest_version: KNOWLEDGE_SOURCE_MANIFEST_VERSION,
    mapping_version: KNOWLEDGE_MAPPING_VERSION,
    source_policies: SOURCE_POLICIES,
    source_roots: [
      { lecture_year: null, root_id: "submission_analysis", source_roles: ["analysis_markdown"] },
      ...(input.transcriptDocument !== undefined
        ? [
            {
              lecture_year: Number(sourceKey.slice(0, 4)),
              root_id: "submission_transcript_document",
              source_roles: ["transcript_text" as const],
            },
          ]
        : transcriptValidation === null
          ? []
          : [
              {
                lecture_year: Number(sourceKey.slice(0, 4)),
                root_id: "submission_transcript",
                source_roles: [
                  "transcript_json",
                  "transcript_qa",
                  "transcript_srt",
                  "transcript_text",
                ],
              },
            ]),
    ],
  });
  const loadedSources: LoadedKnowledgeSource[] = sources.map((source) => ({
    bundle,
    bytes: source.file.bytes,
    descriptor: source.descriptor,
  }));
  return {
    documents: KnowledgeDocumentSetSchema.parse({
      cases: parsed.cases,
      lectures: [parsed.lecture],
      transcriptSegments: [],
    }),
    manifest,
    sources: loadedSources,
  };
}
