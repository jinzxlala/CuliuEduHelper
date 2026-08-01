import { TextDecoder } from "node:util";

import { z } from "zod";

import { AnalysisSectionsSchema, type AnalysisSections } from "./contracts.js";
import { KnowledgeSourceError } from "./errors.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TIME_TOLERANCE_SECONDS = 0.001;

const TranscriptSentenceSchema = z
  .object({
    changes: z.array(z.string()),
    end: z.number().nonnegative(),
    original_text: z.string(),
    start: z.number().nonnegative(),
    text: z.string().min(1),
  })
  .strict()
  .refine((sentence) => sentence.end >= sentence.start, {
    message: "sentence end must not precede its start",
    path: ["end"],
  });

const TranscriptJsonSchema = z
  .object({
    complete: z.literal(true),
    duration_seconds: z.number().positive(),
    forced_aligner: z.string().min(1),
    generated_at: z.iso.datetime({ offset: true }),
    language: z.string().min(1),
    method: z.string().min(1),
    model: z.string().min(1),
    sentence_count: z.number().int().positive(),
    sentences: z.array(TranscriptSentenceSchema).min(1),
    source: z.string().min(1),
    source_json: z.string().min(1),
    tokens: z.unknown(),
    transcribed_until_seconds: z.number().positive(),
    version: z.string().min(1),
  })
  .strict()
  .refine((value) => Array.isArray(value.tokens), {
    message: "tokens must be an array",
    path: ["tokens"],
  });

const TranscriptQaSchema = z
  .object({
    changed_sentence_count: z.number().int().nonnegative(),
    complete: z.literal(true),
    method: z.string().min(1),
    rule_counts: z.record(z.string().min(1), z.number().int().nonnegative()),
    sentence_count: z.number().int().positive(),
    source_json: z.string().min(1),
    source_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    version: z.string().min(1),
  })
  .strict();

interface TimedTextEntry {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

export interface AnalysisMetadata {
  readonly sections: AnalysisSections;
  readonly title: string;
}

export interface TranscriptMetadata {
  readonly changedSentenceCount: number;
  readonly durationSeconds: number;
  readonly sentenceCount: number;
  readonly srtCueCount: number;
  readonly textLineCount: number;
}

function invalidSource(label: string, message: string, cause?: unknown): KnowledgeSourceError {
  return new KnowledgeSourceError("invalid_source", `${label}: ${message}`, {
    cause,
  });
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw invalidSource(label, "file is not valid UTF-8", error);
  }
  if (value.includes("\uFFFD") || value.includes("\0")) {
    throw invalidSource(label, "file contains a replacement or NUL character");
  }
  return value;
}

export function parseAnalysisMarkdown(markdown: string, label: string): AnalysisMetadata {
  const h1Headings = [...markdown.replace(/^\uFEFF/u, "").matchAll(/^#\s+(.+?)\s*$/gmu)]
    .map((match) => match[1])
    .filter((heading): heading is string => heading !== undefined);
  if (h1Headings.length !== 1 || h1Headings[0] === undefined) {
    throw new KnowledgeSourceError(
      "invalid_analysis",
      `${label}: expected exactly one level-one title`,
    );
  }

  const h2Headings = [...markdown.matchAll(/^##\s+(.+?)\s*$/gmu)]
    .map((match) => match[1])
    .filter((heading): heading is string => heading !== undefined);
  const patterns: Readonly<Record<keyof AnalysisSections, RegExp>> = {
    actions: /醋溜科技行动建议/u,
    ai_cross_disciplinary: /AI\+/iu,
    basics: /基础信息/u,
    cases: /案例卡片/u,
    evidence: /证据/u,
    failures: /失败/u,
    quotes: /关键原话/u,
    summary: /摘要/u,
    trends: /趋势/u,
  };

  const sections: Partial<Record<keyof AnalysisSections, string>> = {};
  for (const [section, pattern] of Object.entries(patterns) as Array<
    [keyof AnalysisSections, RegExp]
  >) {
    const matches = h2Headings.filter((heading) => pattern.test(heading));
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new KnowledgeSourceError(
        "invalid_analysis",
        `${label}: expected exactly one ${section} section, found ${String(matches.length)}`,
      );
    }
    sections[section] = matches[0];
  }

  return {
    sections: AnalysisSectionsSchema.parse(sections),
    title: h1Headings[0].trim(),
  };
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw invalidSource(label, "file is not valid JSON", error);
  }
}

function parseSrtTime(value: string, label: string): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  if (match === null) {
    throw invalidSource(label, `invalid SRT time: ${value}`);
  }
  const [, hours = "0", minutes = "0", seconds = "0", milliseconds = "0"] = match;
  return (
    Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000
  );
}

function parsePlainTime(value: string, label: string): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2}\.\d{3})$/u.exec(value);
  if (match === null) {
    throw invalidSource(label, `invalid transcript text time: ${value}`);
  }
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function parseSrt(srt: string, label: string): TimedTextEntry[] {
  const lines = srt
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const entries: TimedTextEntry[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    while (lineIndex < lines.length && lines[lineIndex]?.trim() === "") {
      lineIndex += 1;
    }
    if (lineIndex >= lines.length) {
      break;
    }

    const sequence = lines[lineIndex]?.trim();
    lineIndex += 1;
    if (sequence !== String(entries.length + 1)) {
      throw invalidSource(
        label,
        `expected SRT cue ${String(entries.length + 1)}, found ${sequence ?? "<missing>"}`,
      );
    }

    const timing = lines[lineIndex]?.trim();
    lineIndex += 1;
    const timingMatch = /^(\S+)\s+-->\s+(\S+)$/u.exec(timing ?? "");
    if (timingMatch === null || timingMatch[1] === undefined || timingMatch[2] === undefined) {
      throw invalidSource(label, `cue ${sequence} has an invalid timing line`);
    }

    const textLines: string[] = [];
    while (lineIndex < lines.length && lines[lineIndex]?.trim() !== "") {
      textLines.push(lines[lineIndex] ?? "");
      lineIndex += 1;
    }
    const text = textLines.join("\n");
    if (text.length === 0) {
      throw invalidSource(label, `cue ${sequence} has no text`);
    }
    entries.push({
      end: parseSrtTime(timingMatch[2], label),
      start: parseSrtTime(timingMatch[1], label),
      text,
    });
  }

  return entries;
}

function parseTranscriptText(text: string, label: string): TimedTextEntry[] {
  const lines = text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  while (lines.at(-1)?.trim() === "") {
    lines.pop();
  }

  return lines.map((line, index) => {
    const match = /^\[(\S+)\s+-\s+(\S+)\]\s(.+)$/u.exec(line);
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined
    ) {
      throw invalidSource(label, `line ${String(index + 1)} is not a timestamped transcript line`);
    }
    return {
      end: parsePlainTime(match[2], label),
      start: parsePlainTime(match[1], label),
      text: match[3],
    };
  });
}

function assertEquivalentEntry(
  expected: TimedTextEntry,
  actual: TimedTextEntry,
  representation: string,
  index: number,
  label: string,
): void {
  if (
    Math.abs(expected.start - actual.start) > TIME_TOLERANCE_SECONDS ||
    Math.abs(expected.end - actual.end) > TIME_TOLERANCE_SECONDS
  ) {
    throw invalidSource(label, `${representation} timing differs at segment ${String(index + 1)}`);
  }
  if (expected.text !== actual.text) {
    throw invalidSource(label, `${representation} text differs at segment ${String(index + 1)}`);
  }
}

export function validateTranscriptRepresentations(input: {
  readonly json: string;
  readonly jsonLabel: string;
  readonly qa: string;
  readonly qaLabel: string;
  readonly srt: string;
  readonly srtLabel: string;
  readonly text: string;
  readonly textLabel: string;
}): TranscriptMetadata {
  const parsedJson = TranscriptJsonSchema.safeParse(parseJson(input.json, input.jsonLabel));
  if (!parsedJson.success) {
    throw invalidSource(
      input.jsonLabel,
      "transcript JSON schema validation failed",
      parsedJson.error,
    );
  }
  const transcript = parsedJson.data;
  if (transcript.sentence_count !== transcript.sentences.length) {
    throw invalidSource(input.jsonLabel, "sentence_count does not match sentences length");
  }
  if (transcript.transcribed_until_seconds > transcript.duration_seconds + TIME_TOLERANCE_SECONDS) {
    throw invalidSource(input.jsonLabel, "transcribed duration exceeds media duration");
  }

  let previousStart = -1;
  for (const [index, sentence] of transcript.sentences.entries()) {
    if (sentence.start < previousStart) {
      throw invalidSource(
        input.jsonLabel,
        `sentence start times regress at segment ${String(index + 1)}`,
      );
    }
    if (sentence.end > transcript.duration_seconds + TIME_TOLERANCE_SECONDS) {
      throw invalidSource(
        input.jsonLabel,
        `sentence exceeds media duration at segment ${String(index + 1)}`,
      );
    }
    previousStart = sentence.start;
  }
  const lastSentence = transcript.sentences.at(-1);
  if (
    lastSentence !== undefined &&
    lastSentence.end > transcript.transcribed_until_seconds + TIME_TOLERANCE_SECONDS
  ) {
    throw invalidSource(input.jsonLabel, "last sentence exceeds transcribed duration");
  }

  const changedSentenceCount = transcript.sentences.filter(
    (sentence) => sentence.text !== sentence.original_text,
  ).length;
  const parsedQa = TranscriptQaSchema.safeParse(parseJson(input.qa, input.qaLabel));
  if (!parsedQa.success) {
    throw invalidSource(input.qaLabel, "QA JSON schema validation failed", parsedQa.error);
  }
  if (
    parsedQa.data.sentence_count !== transcript.sentence_count ||
    parsedQa.data.changed_sentence_count !== changedSentenceCount
  ) {
    throw invalidSource(input.qaLabel, "QA counts do not match the cleaned transcript JSON");
  }
  // source_sha256 refers to the pre-cleanup ASR JSON. It is retained as QA metadata,
  // but must not be compared with the hash of the cleaned transcript JSON in this bundle.

  const srtEntries = parseSrt(input.srt, input.srtLabel);
  const textEntries = parseTranscriptText(input.text, input.textLabel);
  if (
    srtEntries.length !== transcript.sentences.length ||
    textEntries.length !== transcript.sentences.length
  ) {
    throw invalidSource(
      input.jsonLabel,
      "JSON, SRT and timestamped text segment counts do not match",
    );
  }

  for (const [index, sentence] of transcript.sentences.entries()) {
    const srtEntry = srtEntries[index];
    const textEntry = textEntries[index];
    if (srtEntry === undefined || textEntry === undefined) {
      throw invalidSource(
        input.jsonLabel,
        `missing redundant representation at segment ${String(index + 1)}`,
      );
    }
    assertEquivalentEntry(sentence, srtEntry, "SRT", index, input.srtLabel);
    assertEquivalentEntry(sentence, textEntry, "text transcript", index, input.textLabel);
  }

  return {
    changedSentenceCount,
    durationSeconds: transcript.duration_seconds,
    sentenceCount: transcript.sentence_count,
    srtCueCount: srtEntries.length,
    textLineCount: textEntries.length,
  };
}
