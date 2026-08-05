import { createHash } from "node:crypto";

import type { JsonModelProvider, JsonModelResult } from "@culiu/ai";
import { z } from "zod";

import { parseCsv } from "./document-parser.js";

export const INCREMENTAL_IMPORT_PROMPT_VERSION = "student-evidence-extract.v2";
export const INCREMENTAL_IMPORT_SCHEMA_VERSION = "student-fact-suggestions.v1";
export const INCREMENTAL_IMPORT_REDACTION_VERSION = "student-evidence-minimal-outbound.v1";

const FactFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/u);

export const IncrementalFactOutputSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            confidence: z.enum(["high", "medium", "low", "unknown"]),
            fieldKey: FactFieldKeySchema,
            informationNature: z.enum(["fact", "inference", "missing", "advisor_judgment"]),
            sourceRef: z.string().regex(/^(?:R[1-9]\d*C[1-9]\d*|P[1-9]\d*)$/u),
            value: z.record(z.string().min(1).max(128), z.json()),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type IncrementalFactOutput = z.infer<typeof IncrementalFactOutputSchema>;

export interface IsolatedStudentMaterial {
  readonly allowedSourceRefs: ReadonlySet<string>;
  readonly text: string;
}

function normalizedAlias(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s()（）【】_-]|\[|\]/gu, "");
}

export function isolateStudentCsv(
  text: string,
  aliases: readonly string[],
): IsolatedStudentMaterial {
  const normalizedAliases = aliases.map(normalizedAlias).filter((alias) => alias.length >= 2);
  if (normalizedAliases.length === 0)
    throw new Error("At least one confirmed student alias is required.");
  const rows = parseCsv(text.replace(/^\uFEFF/u, ""));
  const header = rows[0];
  if (header === undefined) throw new Error("CSV header is missing.");
  const matchingColumns = header.flatMap((cell, column) => {
    const normalizedHeader = normalizedAlias(cell);
    return normalizedAliases.some((alias) => normalizedHeader.includes(alias)) ? [column] : [];
  });
  if (matchingColumns.length !== 1 || matchingColumns[0] === undefined) {
    throw new Error("CSV must contain exactly one column matching the selected student.");
  }
  const studentColumn = matchingColumns[0];
  const commonColumns = header
    .map((cell, column) => ({ cell: normalizedAlias(cell), column }))
    .filter(
      ({ cell, column }) =>
        column !== studentColumn && /^(日期|时间|课程|课程内容|content|date|time)$/u.test(cell),
    )
    .map(({ column }) => column);
  const selectedColumns = [...new Set([...commonColumns, studentColumn])].sort((a, b) => a - b);
  const allowedSourceRefs = new Set<string>();
  const output = rows.map((row, rowIndex) =>
    selectedColumns
      .map((column) => {
        const sourceRef = `R${String(rowIndex + 1)}C${String(column + 1)}`;
        allowedSourceRefs.add(sourceRef);
        return `[${sourceRef}] ${row[column] ?? ""}`;
      })
      .join(" | "),
  );
  return { allowedSourceRefs, text: output.join("\n") };
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}(?!\d)/gu;
const LONG_ID_PATTERN = /(?<![A-Za-z0-9])[A-Za-z0-9]{15,18}(?![A-Za-z0-9])/gu;
const PUBLIC_CODE_PATTERN = /\bSTU-[A-Z0-9_-]{4,64}\b/gu;

export function redactSelectedStudentMaterial(
  material: IsolatedStudentMaterial,
  identities: readonly string[],
): IsolatedStudentMaterial {
  let text = material.text;
  const unique = [...new Set(identities.map((identity) => identity.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const identity of unique) text = text.replaceAll(identity, "[STUDENT]");
  text = text
    .replace(EMAIL_PATTERN, "[EMAIL]")
    .replace(PHONE_PATTERN, "[PHONE]")
    .replace(PUBLIC_CODE_PATTERN, "[STUDENT_CODE]")
    .replace(LONG_ID_PATTERN, "[LONG_ID]");
  return { allowedSourceRefs: material.allowedSourceRefs, text };
}

const SYSTEM_PROMPT = `你是单一学生证据事实提取助手。输入已经只保留目标学生材料并完成身份脱敏。
只提取原文明确支持的事实或有明确依据的推断；不得补全其他学生信息。输出严格 JSON：{"suggestions":[{"fieldKey":"稳定小写命名空间键","value":{"text":"建议值"},"informationNature":"fact|inference|missing|advisor_judgment","confidence":"high|medium|low|unknown","sourceRef":"P1"}]}。suggestions 必须是数组，每项只能包含示例中的五个字段。sourceRef 必须是输入中存在的单个 R行C列或 P段落编号，例如 P1 或 R2C3；不要包含方括号、多个编号、编号范围、解释文字或数据库 ID。`;

export const INCREMENTAL_IMPORT_PROMPT_HASH = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex");
export const INCREMENTAL_IMPORT_SCHEMA_HASH = createHash("sha256")
  .update(INCREMENTAL_IMPORT_SCHEMA_VERSION)
  .digest("hex");

export async function extractIncrementalFactSuggestions(
  provider: JsonModelProvider,
  material: IsolatedStudentMaterial,
): Promise<{ output: IncrementalFactOutput; provider: JsonModelResult }> {
  const providerResult = await provider.generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `仅处理以下目标学生材料：\n\n${material.text}`,
  });
  const untrustedOutput = providerResult.json;
  if (
    untrustedOutput !== null &&
    typeof untrustedOutput === "object" &&
    !Array.isArray(untrustedOutput) &&
    Array.isArray((untrustedOutput as { suggestions?: unknown }).suggestions)
  ) {
    const suggestions = (untrustedOutput as { suggestions: unknown[] }).suggestions.map(
      (suggestion) => {
        if (suggestion === null || typeof suggestion !== "object" || Array.isArray(suggestion)) {
          return suggestion;
        }
        const sourceRef = (suggestion as { sourceRef?: unknown }).sourceRef;
        const match =
          typeof sourceRef === "string"
            ? /^\[(R[1-9]\d*C[1-9]\d*|P[1-9]\d*)\]$/u.exec(sourceRef.trim())
            : null;
        return match?.[1] === undefined ? suggestion : { ...suggestion, sourceRef: match[1] };
      },
    );
    const output = IncrementalFactOutputSchema.parse({ ...untrustedOutput, suggestions });
    for (const suggestion of output.suggestions) {
      if (!material.allowedSourceRefs.has(suggestion.sourceRef)) {
        throw new Error("Model returned a sourceRef outside the isolated student material.");
      }
    }
    return { output, provider: providerResult };
  }
  const output = IncrementalFactOutputSchema.parse(untrustedOutput);
  for (const suggestion of output.suggestions) {
    if (!material.allowedSourceRefs.has(suggestion.sourceRef)) {
      throw new Error("Model returned a sourceRef outside the isolated student material.");
    }
  }
  return { output, provider: providerResult };
}

export function paragraphMaterial(text: string): IsolatedStudentMaterial {
  const paragraphs = text
    .split(/\r?\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const allowedSourceRefs = new Set(paragraphs.map((_, index) => `P${String(index + 1)}`));
  return {
    allowedSourceRefs,
    text: paragraphs.map((paragraph, index) => `[P${String(index + 1)}] ${paragraph}`).join("\n"),
  };
}
