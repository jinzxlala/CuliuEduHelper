import { createHash } from "node:crypto";

import type { JsonModelProvider, JsonModelResult } from "@culiu/ai";

import {
  BasicStudentImportModelOutputSchema,
  type BasicStudentImportModelOutput,
  type RedactedStudentImport,
} from "./contracts.js";
import { restorePhoneToken } from "./privacy.js";

export const BASIC_IMPORT_PROMPT_VERSION = "student-basic-import.v1";
export const BASIC_IMPORT_SCHEMA_VERSION = "student-basic-candidates.v1";
export const BASIC_IMPORT_REDACTION_VERSION = "student-basic-minimal-outbound.v1";

const SYSTEM_PROMPT = `你是学生基础资料结构化助手。仅提取材料中明确出现的信息，不推断、不补全。
输出严格 JSON 对象：{"candidates":[{"sourceOrdinal":1,"displayLabel":"用于审核的简短标签","fields":[{"fieldKey":"identity.chinese_name|identity.english_name|education.grade|identity.birth_date|education.school|contact.parent_phone","value":"原文值；电话必须保留为[PHONE_n]占位符","confidence":"high|medium|low|unknown","sourceLocator":{"row":1,"column":1}或{"start":0,"end":10}}]}]}。
每位学生一个 candidate；没有英文名时 value 写“无”；不得输出未在材料中出现的学生、联系方式或说明文字。`;

export const BASIC_IMPORT_PROMPT_HASH = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
export const BASIC_IMPORT_SCHEMA_HASH = createHash("sha256")
  .update(BASIC_IMPORT_SCHEMA_VERSION)
  .digest("hex");

export interface BasicExtractionResult {
  readonly modelOutput: BasicStudentImportModelOutput;
  readonly provider: JsonModelResult;
}

export async function extractBasicStudentCandidates(
  provider: JsonModelProvider,
  redacted: RedactedStudentImport,
): Promise<BasicExtractionResult> {
  const result = await provider.generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `待提取材料如下。只处理这些内容：\n\n${redacted.text}`,
  });
  const parsed = BasicStudentImportModelOutputSchema.parse(result.json);
  const modelOutput = BasicStudentImportModelOutputSchema.parse({
    candidates: parsed.candidates.map((candidate) => ({
      ...candidate,
      fields: candidate.fields.map((field) => ({
        ...field,
        value:
          field.fieldKey === "contact.parent_phone"
            ? restorePhoneToken(field.value, redacted.phoneTokens)
            : field.value,
      })),
    })),
  });
  return { modelOutput, provider: result };
}
