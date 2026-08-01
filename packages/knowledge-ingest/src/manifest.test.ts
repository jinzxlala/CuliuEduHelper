import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KnowledgeSourceManifestSchema } from "./contracts.js";
import {
  buildKnowledgeSourceManifest,
  serializeKnowledgeSourceManifest,
  verifyKnowledgeSourceManifest,
  writeKnowledgeSourceManifest,
  type TranscriptRootInput,
} from "./manifest.js";

interface FixtureCorpus {
  readonly analysisRoot: string;
  readonly base: string;
  readonly sourceKeys: string[];
  readonly transcriptRoots: TranscriptRootInput[];
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

function analysisMarkdown(sourceKey: string): string {
  return `# Synthetic ${sourceKey}

## 1. 基础信息

Synthetic.

## 2. 约300字摘要

Synthetic.

## 3. 趋势清单

Synthetic.

## 4. 案例卡片

Synthetic.

## 5. AI+与跨学科

Synthetic.

## 6. 失败与避坑

Synthetic.

## 7. 关键原话

Synthetic.

## 8. 醋溜科技行动建议

Synthetic.

## 9. 证据边界

Synthetic.
`;
}

function transcriptJson(): string {
  return JSON.stringify({
    complete: true,
    duration_seconds: 2,
    forced_aligner: "synthetic aligner",
    generated_at: "2026-07-30T16:35:46+08:00",
    language: "Chinese",
    method: "synthetic fixture",
    model: "synthetic model",
    sentence_count: 1,
    sentences: [
      {
        changes: [],
        end: 1.5,
        original_text: "虚构测试内容。",
        start: 0.1,
        text: "虚构测试内容。",
      },
    ],
    source: "C:/redacted/source.mp4",
    source_json: "C:/redacted/source.json",
    tokens: [],
    transcribed_until_seconds: 2,
    version: "synthetic-v1",
  });
}

function qaJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    changed_sentence_count: 0,
    complete: true,
    method: "synthetic fixture",
    rule_counts: {},
    sentence_count: 1,
    source_json: "C:/redacted/source.json",
    source_sha256: "0".repeat(64),
    version: "synthetic-v1",
    ...overrides,
  });
}

async function createFixtureCorpus(): Promise<FixtureCorpus> {
  const base = await mkdtemp(join(tmpdir(), "culiu-knowledge-ingest-"));
  temporaryDirectories.push(base);
  const analysisRoot = join(base, "analysis");
  const transcript2025 = join(base, "transcripts-2025");
  const transcript2026 = join(base, "transcripts-2026");
  await Promise.all([mkdir(analysisRoot), mkdir(transcript2025), mkdir(transcript2026)]);

  const sourceKeys: string[] = [];
  for (const year of [2025, 2026]) {
    const transcriptRoot = year === 2025 ? transcript2025 : transcript2026;
    for (let day = 1; day <= 24; day += 1) {
      const sourceKey = `${String(year)}-01-${String(day).padStart(2, "0")}_synthetic_${String(day)}`;
      sourceKeys.push(sourceKey);
      await Promise.all([
        writeFile(join(analysisRoot, `${sourceKey}.md`), analysisMarkdown(sourceKey), "utf8"),
        writeFile(join(transcriptRoot, `${sourceKey}.json`), transcriptJson(), "utf8"),
        writeFile(join(transcriptRoot, `${sourceKey}.qa.json`), qaJson(), "utf8"),
        writeFile(
          join(transcriptRoot, `${sourceKey}.srt`),
          "1\n00:00:00,100 --> 00:00:01,500\n虚构测试内容。\n",
          "utf8",
        ),
        writeFile(
          join(transcriptRoot, `${sourceKey}.txt`),
          "[00:00:00.100 - 00:00:01.500] 虚构测试内容。\n",
          "utf8",
        ),
      ]);
    }
  }
  await writeFile(join(transcript2026, "_整理汇总.json"), "{}\n", "utf8");

  return {
    analysisRoot,
    base,
    sourceKeys,
    transcriptRoots: [
      { lectureYear: 2025, path: transcript2025 },
      { lectureYear: 2026, path: transcript2026 },
    ],
  };
}

function firstSourceKey(fixture: FixtureCorpus): string {
  const sourceKey = fixture.sourceKeys[0];
  if (sourceKey === undefined) {
    throw new Error("fixture did not create a source key");
  }
  return sourceKey;
}

describe("knowledge source manifest", () => {
  it("builds a deterministic content-addressed inventory without leaking host paths", async () => {
    const fixture = await createFixtureCorpus();
    const first = await buildKnowledgeSourceManifest(fixture);
    const second = await buildKnowledgeSourceManifest(fixture);
    const serialized = serializeKnowledgeSourceManifest(first);

    expect(second).toEqual(first);
    expect(first.lecture_count).toBe(48);
    expect(first.lectures).toHaveLength(48);
    expect(first.excluded_files).toEqual([
      {
        reason: "aggregate_not_primary_source",
        relative_path: "_整理汇总.json",
        root_id: "transcripts_2026",
      },
    ]);
    expect(first.lectures[0]?.sources.map((source) => source.role)).toEqual([
      "analysis_markdown",
      "transcript_json",
      "transcript_qa",
      "transcript_srt",
      "transcript_text",
    ]);
    expect(first.lectures[0]?.transcript_validation).toEqual({
      changed_sentence_count: 0,
      duration_seconds: 2,
      sentence_count: 1,
      srt_cue_count: 1,
      text_line_count: 1,
    });
    expect(serialized).not.toContain(fixture.base.replaceAll("\\", "/"));
    expect(serialized).not.toContain(fixture.base);
    expect(serialized).not.toContain("C:/redacted");
    expect(KnowledgeSourceManifestSchema.parse(JSON.parse(serialized))).toEqual(first);
  });

  it("writes the canonical UTF-8 JSON representation", async () => {
    const fixture = await createFixtureCorpus();
    const outputPath = join(fixture.base, "output", "manifest.json");
    const manifest = await writeKnowledgeSourceManifest({ ...fixture, outputPath });
    const contents = await readFile(outputPath, "utf8");

    expect(contents).toBe(serializeKnowledgeSourceManifest(manifest));
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("rejects a missing transcript role", async () => {
    const fixture = await createFixtureCorpus();
    const sourceKey = firstSourceKey(fixture);
    await unlink(join(fixture.transcriptRoots[0]?.path ?? "", `${sourceKey}.txt`));

    await expect(buildKnowledgeSourceManifest(fixture)).rejects.toMatchObject({
      code: "missing_source",
    });
  });

  it("rejects source-set drift", async () => {
    const fixture = await createFixtureCorpus();
    await writeFile(
      join(fixture.analysisRoot, "2026-02-01_unpaired.md"),
      analysisMarkdown("2026-02-01_unpaired"),
      "utf8",
    );

    await expect(buildKnowledgeSourceManifest(fixture)).rejects.toMatchObject({
      code: "source_set_mismatch",
    });
  });

  it("rejects unexpected files instead of silently expanding the corpus", async () => {
    const fixture = await createFixtureCorpus();
    await writeFile(join(fixture.transcriptRoots[0]?.path ?? "", "notes.json"), "{}", "utf8");

    await expect(buildKnowledgeSourceManifest(fixture)).rejects.toMatchObject({
      code: "unexpected_source",
    });
  });

  it("rejects analysis documents missing a required semantic section", async () => {
    const fixture = await createFixtureCorpus();
    const sourceKey = firstSourceKey(fixture);
    const path = join(fixture.analysisRoot, `${sourceKey}.md`);
    const markdown = await readFile(path, "utf8");
    await writeFile(path, markdown.replace("## 9. 证据边界", "## 9. 其他说明"), "utf8");

    await expect(buildKnowledgeSourceManifest(fixture)).rejects.toMatchObject({
      code: "invalid_analysis",
    });
  });

  it("rejects timing or text drift between JSON and SRT", async () => {
    const fixture = await createFixtureCorpus();
    const sourceKey = firstSourceKey(fixture);
    const srtPath = join(fixture.transcriptRoots[0]?.path ?? "", `${sourceKey}.srt`);
    await writeFile(srtPath, "1\n00:00:00,200 --> 00:00:01,500\n虚构测试内容。\n", "utf8");

    await expect(buildKnowledgeSourceManifest(fixture)).rejects.toMatchObject({
      code: "invalid_source",
    });
  });

  it("rejects QA counts that do not describe the cleaned transcript", async () => {
    const fixture = await createFixtureCorpus();
    const sourceKey = firstSourceKey(fixture);
    await writeFile(
      join(fixture.transcriptRoots[0]?.path ?? "", `${sourceKey}.qa.json`),
      qaJson({ changed_sentence_count: 1 }),
      "utf8",
    );

    await expect(buildKnowledgeSourceManifest(fixture)).rejects.toMatchObject({
      code: "invalid_source",
    });
  });

  it("detects tampering with bundle and corpus hashes", async () => {
    const fixture = await createFixtureCorpus();
    const manifest = await buildKnowledgeSourceManifest(fixture);
    const tampered = structuredClone(manifest);
    const firstLecture = tampered.lectures[0];
    expect(firstLecture).toBeDefined();
    if (firstLecture !== undefined) {
      firstLecture.bundle_hash = "f".repeat(64);
    }

    expect(() => verifyKnowledgeSourceManifest(tampered)).toThrow(/bundle hash/u);
  });
});
