import { basename, extname } from "node:path";

import mammoth from "mammoth";

import { contentSha256 } from "./analysis-documents.js";
import { KnowledgeSourceError } from "./errors.js";
import { knowledgeLectureId } from "./manifest.js";
import { decodeUtf8 } from "./source-parsers.js";
import { MAX_KNOWLEDGE_SUBMISSION_BYTES, type SubmittedKnowledgeFile } from "./submission.js";

export const MAX_TRANSCRIPT_TEXT_CHARACTERS = 500_000;
const SOURCE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})_(.+)$/u;

export interface ParsedTranscriptDocument {
  readonly byteCount: number;
  readonly contentHash: string;
  readonly file: SubmittedKnowledgeFile;
  readonly lectureId: string;
  readonly mimeType:
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "text/markdown";
  readonly sourceKey: string;
  readonly text: string;
  readonly textHash: string;
  readonly title: string;
}

export interface TranscriptDocumentParserOptions {
  readonly extractDocxText?: (bytes: Uint8Array) => Promise<string>;
}

function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeTranscriptText(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/./gsu, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0 ||
        code === 8 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
        ? " "
        : character;
    })
    .trim();
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  } catch (error) {
    throw new KnowledgeSourceError(
      "invalid_source",
      "Word transcript could not be read; save it as a valid .docx file and retry",
      { cause: error },
    );
  }
}

export async function parseTranscriptDocument(
  file: SubmittedKnowledgeFile,
  options: TranscriptDocumentParserOptions = {},
): Promise<ParsedTranscriptDocument> {
  if (basename(file.fileName) !== file.fileName || /[\\/]/u.test(file.fileName)) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "uploaded file names must not contain paths",
    );
  }
  if (file.fileName.length > 255 || /[\u0000-\u001f\u007f]/u.test(file.fileName)) {
    throw new KnowledgeSourceError("unexpected_source", "uploaded file name is not safe");
  }
  if (file.bytes.byteLength === 0) {
    throw new KnowledgeSourceError("invalid_source", `${file.fileName}: file is empty`);
  }
  if (file.bytes.byteLength > MAX_KNOWLEDGE_SUBMISSION_BYTES) {
    throw new KnowledgeSourceError("invalid_source", "transcript file exceeds 20 MB");
  }
  const extension = extname(file.fileName).toLowerCase();
  if (extension !== ".md" && extension !== ".docx") {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "transcript file must use the .md or .docx extension",
    );
  }
  const fileNameStem = basename(file.fileName, extname(file.fileName)).trim();
  if (fileNameStem === "") {
    throw new KnowledgeSourceError("unexpected_source", "transcript file name is empty");
  }
  const extracted =
    extension === ".md"
      ? decodeUtf8(file.bytes, file.fileName)
      : await (options.extractDocxText ?? extractDocx)(file.bytes);
  const text = normalizeTranscriptText(extracted);
  if (text.length === 0) {
    throw new KnowledgeSourceError("invalid_source", `${file.fileName}: transcript text is empty`);
  }
  if (text.length > MAX_TRANSCRIPT_TEXT_CHARACTERS) {
    throw new KnowledgeSourceError(
      "invalid_source",
      `transcript text exceeds ${String(MAX_TRANSCRIPT_TEXT_CHARACTERS)} characters`,
    );
  }
  const contentHash = contentSha256(file.bytes);
  const strictName = SOURCE_FILE_PATTERN.exec(fileNameStem);
  const strictDate = strictName?.[1];
  const strictTitle = strictName?.[2]?.trim();
  const hasCanonicalName =
    strictDate !== undefined &&
    strictTitle !== undefined &&
    strictTitle !== "" &&
    isValidDate(strictDate);
  const title = hasCanonicalName ? strictTitle : fileNameStem;
  const sourceKey = hasCanonicalName
    ? `${strictDate}_${strictTitle}`
    : `pending_${contentHash.slice(0, 32)}`;
  const lectureId = hasCanonicalName ? knowledgeLectureId(sourceKey) : `lecture_${sourceKey}`;
  return {
    byteCount: file.bytes.byteLength,
    contentHash,
    file,
    lectureId,
    mimeType:
      extension === ".md"
        ? "text/markdown"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sourceKey,
    text,
    textHash: contentSha256(Buffer.from(text, "utf8")),
    title,
  };
}
