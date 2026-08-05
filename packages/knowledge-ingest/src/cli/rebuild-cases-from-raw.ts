import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  DeepSeekJsonModelProvider,
  ModelGatewayError,
  parseDeepSeekGatewayConfig,
} from "@culiu/ai";
import { ZodError } from "zod";

import { parseAnalysisDocuments } from "../analysis-documents.js";
import { selectCaseEvidenceWindows } from "../case-evidence-windows.js";
import { KnowledgeSourceManifestSchema } from "../contracts.js";
import {
  buildKnowledgeCaseRebuildUserPrompt,
  KNOWLEDGE_CASE_REBUILD_SCHEMA_VERSION,
  KNOWLEDGE_CASE_REBUILD_SYSTEM_PROMPT,
  KnowledgeCaseRebuildOutputSchema,
  renderKnowledgeCaseBlocks,
} from "../knowledge-extraction.js";

function replaceCaseSection(markdown: string, heading: string, body: string): string {
  const normalized = markdown.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const marker = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) throw new Error(`Analysis is missing case section: ${heading}`);
  const end = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line.trim()));
  const replacement = [marker, "", body, ""];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end === -1 ? lines.length : end)]
    .join("\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trimEnd()
    .concat("\n");
}

function caseQualityIssues(
  cases: ReturnType<typeof KnowledgeCaseRebuildOutputSchema.parse>["cases"],
): string[] {
  const issues: string[] = [];
  const timestampPattern =
    /\[?\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\s*-\s*\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\]?/u;
  const missingPattern = /未披露|未说明|未明确|没有披露|不详|未知/u;
  for (const [index, item] of cases.entries()) {
    const label = `case ${String(index + 1)} (${item.heading})`;
    if (item.verifiedFacts.length < 2) issues.push(`${label}: fewer than 2 verified facts`);
    if (item.developmentPath.length < 2) issues.push(`${label}: development path is too thin`);
    if (item.coreProjects.length < 1) issues.push(`${label}: no core project or activity`);
    if (item.coreStrengths.length < 1) issues.push(`${label}: no evidence-based strength`);
    const locators = new Set(item.evidencePoints.map((point) => point.sourceLocator));
    if (locators.size < 2 || [...locators].some((locator) => !timestampPattern.test(locator))) {
      issues.push(`${label}: needs at least 2 distinct valid timestamp locators`);
    }
    if (
      !missingPattern.test(item.admissionResult) &&
      !item.evidencePoints.some((point) => /录取|转入|进入|offer/iu.test(point.claim))
    ) {
      issues.push(`${label}: admission result lacks a direct evidence point`);
    }
    if (/逆袭|打动招生官|成功关键/u.test(item.heading)) {
      issues.push(`${label}: heading contains causal or promotional language`);
    }
    if (
      !/研究|结合|应用|实践|探索|利用|解决|构建|分析|项目|主线|科技|社会|工程|公益|创新|设计|跨学科/u.test(
        item.academicLabel,
      )
    ) {
      issues.push(`${label}: academic label does not describe a substantive method or theme`);
    }
    if (
      item.interpretations.some((value) => /录取得益于|成功关键|打动招生官|因此被录取/u.test(value))
    ) {
      issues.push(`${label}: interpretation overstates admission causality`);
    }
  }
  return issues;
}

async function generateWithRetry(
  provider: DeepSeekJsonModelProvider,
  input: { readonly evidenceText: string; readonly sourceKey: string; readonly title: string },
): Promise<
  ReturnType<typeof KnowledgeCaseRebuildOutputSchema.parse> & {
    discardedCases: number;
    usageTokens: number;
  }
> {
  let lastError: unknown;
  let correction = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await provider.generateJson({
        systemPrompt: KNOWLEDGE_CASE_REBUILD_SYSTEM_PROMPT,
        userPrompt: `${buildKnowledgeCaseRebuildUserPrompt(input)}${correction}`,
      });
      const parsed = KnowledgeCaseRebuildOutputSchema.parse(result.json);
      const strongCases = parsed.cases.filter((item) => caseQualityIssues([item]).length === 0);
      return {
        ...parsed,
        cases: strongCases,
        discardedCases: parsed.cases.length - strongCases.length,
        usageTokens: result.usage.totalTokens,
      };
    } catch (error) {
      lastError = error;
      if (correction !== "" && attempt < 3) continue;
      if (error instanceof ZodError && attempt < 3) {
        correction = `\n\n上一版JSON未通过Schema。请重新输出完整JSON，确保每个字段都存在且类型正确。错误位置：${error.issues
          .slice(0, 12)
          .map((issue) => issue.path.join("."))
          .join("；")}`;
        continue;
      }
      if (
        error instanceof ModelGatewayError &&
        attempt < 3 &&
        (error.detailCode === "content_invalid_json" || error.detailCode === "output_truncated")
      ) {
        correction =
          "\n\n上一版不是完整有效的JSON。请减少案例数量和每项篇幅，只保留证据最充分的案例，并确保JSON完整闭合。";
        continue;
      }
      if (!(error instanceof ModelGatewayError) || !error.retryable || attempt === 3) throw error;
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, "../../../..");
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      apply: { type: "boolean" },
      "analysis-root": { default: join(repositoryRoot, "data_origin"), type: "string" },
      limit: { type: "string" },
      manifest: {
        default: join(repositoryRoot, "knowledge", "source-manifest.v1.json"),
        type: "string",
      },
      "output-root": { type: "string" },
      "raw-root": { default: join(repositoryRoot, "data_origin", "raw"), type: "string" },
      resume: { type: "boolean" },
      "source-key": { type: "string" },
    },
    strict: true,
  });
  const analysisRoot = resolve(parsed.values["analysis-root"]);
  const rawRoot = resolve(parsed.values["raw-root"]);
  const outputRoot = resolve(
    parsed.values["output-root"] ??
      join(
        repositoryRoot,
        ".local-data",
        "knowledge-case-rebuild",
        new Date().toISOString().replace(/[:.]/gu, "-"),
      ),
  );
  const manifest = KnowledgeSourceManifestSchema.parse(
    JSON.parse(await readFile(resolve(parsed.values.manifest), "utf8")),
  );
  const requestedLimit =
    parsed.values.limit === undefined ? undefined : Number.parseInt(parsed.values.limit, 10);
  if (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  let lectures = manifest.lectures;
  if (parsed.values["source-key"] !== undefined) {
    lectures = lectures.filter((lecture) => lecture.source_key === parsed.values["source-key"]);
  }
  if (requestedLimit !== undefined) lectures = lectures.slice(0, requestedLimit);
  if (lectures.length === 0) throw new Error("No matching lectures were found in the manifest.");

  const config = parseDeepSeekGatewayConfig();
  const provider = new DeepSeekJsonModelProvider({
    ...config,
    maxTokens: 16_384,
    timeoutMs: 120_000,
  });
  const stagedRoot = join(outputRoot, "analysis");
  const originalRoot = join(outputRoot, "originals");
  await mkdir(stagedRoot, { recursive: true });
  if (parsed.values.apply === true) await mkdir(originalRoot, { recursive: true });

  const summary: Array<{
    caseCount: number;
    discardedCases: number;
    evidenceCharacters: number;
    reused: boolean;
    sourceKey: string;
    tokens: number;
  }> = [];
  for (const [index, lecture] of lectures.entries()) {
    const fileName = `${lecture.source_key}.md`;
    const rawPath = join(rawRoot, fileName);
    const analysisSource = lecture.sources.find((source) => source.role === "analysis_markdown");
    if (analysisSource === undefined)
      throw new Error(`${lecture.source_key}: analysis source missing`);
    const analysisPath = join(analysisRoot, analysisSource.relative_path);
    const stagedPath = join(stagedRoot, fileName);
    if (parsed.values.resume === true) {
      try {
        const stagedAnalysis = await readFile(stagedPath, "utf8");
        const staged = parseAnalysisDocuments(stagedAnalysis, lecture, basename(stagedPath));
        process.stdout.write(
          `[${String(index + 1)}/${String(lectures.length)}] ${lecture.source_key}: reused ${String(staged.cases.length)} validated cases\n`,
        );
        summary.push({
          caseCount: staged.cases.length,
          discardedCases: 0,
          evidenceCharacters: 0,
          reused: true,
          sourceKey: lecture.source_key,
          tokens: 0,
        });
        continue;
      } catch {
        // Missing or invalid staged output is regenerated below.
      }
    }
    const transcript = await readFile(rawPath, "utf8");
    const currentAnalysis = await readFile(analysisPath, "utf8");
    const evidenceText = selectCaseEvidenceWindows(transcript);
    process.stdout.write(
      `[${String(index + 1)}/${String(lectures.length)}] ${lecture.source_key}: ${String(evidenceText.length)} evidence characters\n`,
    );
    const output =
      evidenceText === ""
        ? {
            cases: [],
            discardedCases: 0,
            schemaVersion: KNOWLEDGE_CASE_REBUILD_SCHEMA_VERSION,
            usageTokens: 0,
          }
        : await generateWithRetry(provider, {
            evidenceText,
            sourceKey: lecture.source_key,
            title: lecture.title,
          });
    const nextAnalysis = replaceCaseSection(
      currentAnalysis,
      lecture.analysis_sections.cases,
      renderKnowledgeCaseBlocks(output.cases),
    );
    parseAnalysisDocuments(nextAnalysis, lecture, basename(analysisPath));
    await writeFile(stagedPath, nextAnalysis, "utf8");
    summary.push({
      caseCount: output.cases.length,
      discardedCases: output.discardedCases,
      evidenceCharacters: evidenceText.length,
      reused: false,
      sourceKey: lecture.source_key,
      tokens: output.usageTokens,
    });
  }

  await writeFile(
    join(outputRoot, "summary.json"),
    `${JSON.stringify(
      {
        caseCount: summary.reduce((total, item) => total + item.caseCount, 0),
        discardedCaseCount: summary.reduce((total, item) => total + item.discardedCases, 0),
        generatedAt: new Date().toISOString(),
        lectureCount: summary.length,
        model: "deepseek-v4-flash",
        schemaVersion: KNOWLEDGE_CASE_REBUILD_SCHEMA_VERSION,
        totalTokens: summary.reduce((total, item) => total + item.tokens, 0),
        lectures: summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (parsed.values.apply === true) {
    for (const lecture of lectures) {
      const fileName = `${lecture.source_key}.md`;
      const analysisSource = lecture.sources.find((source) => source.role === "analysis_markdown");
      if (analysisSource === undefined)
        throw new Error(`${lecture.source_key}: analysis source missing`);
      const analysisPath = join(analysisRoot, analysisSource.relative_path);
      await copyFile(analysisPath, join(originalRoot, fileName));
      await copyFile(join(stagedRoot, fileName), analysisPath);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ applied: parsed.values.apply === true, outputRoot, ...summary.reduce((totals, item) => ({ cases: totals.cases + item.caseCount, tokens: totals.tokens + item.tokens }), { cases: 0, tokens: 0 }) })}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown case rebuild failure";
  process.stderr.write(`Knowledge case rebuild failed: ${message}\n`);
  process.exitCode = 1;
}
