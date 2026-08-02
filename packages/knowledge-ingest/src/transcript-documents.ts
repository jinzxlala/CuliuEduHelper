import { basename } from "node:path";

import mammoth from "mammoth";

import { contentSha256 } from "./analysis-documents.js";
import { KnowledgeSourceError } from "./errors.js";
import { knowledgeLectureId } from "./manifest.js";
import { decodeUtf8 } from "./source-parsers.js";
import { MAX_KNOWLEDGE_SUBMISSION_BYTES, type SubmittedKnowledgeFile } from "./submission.js";

export const MAX_TRANSCRIPT_TEXT_CHARACTERS = 500_000;
const SOURCE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})_(.+)\.(md|docx)$/u;

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

function validateDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new KnowledgeSourceError("unexpected_source", "transcript file name has an invalid date");
  }
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
  if (file.bytes.byteLength === 0) {
    throw new KnowledgeSourceError("invalid_source", `${file.fileName}: file is empty`);
  }
  if (file.bytes.byteLength > MAX_KNOWLEDGE_SUBMISSION_BYTES) {
    throw new KnowledgeSourceError("invalid_source", "transcript file exceeds 20 MB");
  }
  const match = SOURCE_FILE_PATTERN.exec(file.fileName);
  const date = match?.[1];
  const title = match?.[2]?.trim();
  const extension = match?.[3];
  if (date === undefined || title === undefined || title === "" || extension === undefined) {
    throw new KnowledgeSourceError(
      "unexpected_source",
      "transcript file name must follow YYYY-MM-DD_title.md or YYYY-MM-DD_title.docx",
    );
  }
  validateDate(date);
  const sourceKey = `${date}_${title}`;
  const extracted =
    extension === "md"
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
  return {
    byteCount: file.bytes.byteLength,
    contentHash: contentSha256(file.bytes),
    file,
    lectureId: knowledgeLectureId(sourceKey),
    mimeType:
      extension === "md"
        ? "text/markdown"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sourceKey,
    text,
    textHash: contentSha256(Buffer.from(text, "utf8")),
    title,
  };
}
