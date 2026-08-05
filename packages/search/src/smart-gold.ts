import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { KnowledgeSearchService } from "./service.js";

const IdentitySchema = z
  .object({
    corpus_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    corpus_id: z.string().min(1),
    manifest_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    mapping_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .strict();
const ApprovalSchema = z.discriminatedUnion("status", [
  z.object({ reviewed_at: z.null(), reviewed_by: z.null(), status: z.literal("draft") }).strict(),
  z
    .object({
      reviewed_at: z.iso.datetime({ offset: true }),
      reviewed_by: z.string().trim().min(1),
      status: z.literal("approved"),
    })
    .strict(),
]);
const QuerySchema = z
  .object({
    expected_hit_ids: z
      .array(z.string().regex(/^(?:lecture|case)_/u))
      .min(1)
      .max(10),
    id: z.string().regex(/^smart_\d{3}$/u),
    prompt: z.string().trim().min(8).max(1_000),
    retrieval_query: z.string().trim().min(1).max(500),
    target: z.enum(["lectures", "cases"]),
  })
  .strict()
  .superRefine((query, context) => {
    const prefix = query.target === "lectures" ? "lecture_" : "case_";
    query.expected_hit_ids.forEach((id, index) => {
      if (!id.startsWith(prefix))
        context.addIssue({
          code: "custom",
          message: "Expected ID type does not match target.",
          path: ["expected_hit_ids", index],
        });
    });
  });

export const SmartSearchGoldSetSchema = z
  .object({
    approval: ApprovalSchema,
    corpus: IdentitySchema,
    drafted_at: z.iso.datetime({ offset: true }),
    drafted_by: z.literal("Code Agent"),
    fixture_id: z.literal("eduknow_smart_search_gold_v1"),
    fixture_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    queries: z.array(QuerySchema).min(30).max(200),
    schema_version: z.literal("1.0.0"),
    thresholds: z.object({ candidate_recall_at_30_min: z.number().min(0.9).max(1) }).strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    const ids = new Set<string>();
    const prompts = new Set<string>();
    fixture.queries.forEach((query, index) => {
      if (ids.has(query.id))
        context.addIssue({
          code: "custom",
          message: "Query IDs must be unique.",
          path: ["queries", index, "id"],
        });
      if (prompts.has(query.prompt))
        context.addIssue({
          code: "custom",
          message: "Prompts must be unique.",
          path: ["queries", index, "prompt"],
        });
      ids.add(query.id);
      prompts.add(query.prompt);
    });
  });
export type SmartSearchGoldSet = z.infer<typeof SmartSearchGoldSetSchema>;

export async function loadSmartSearchGoldSet(
  fixturePath: string,
  manifestPath: string,
): Promise<SmartSearchGoldSet> {
  const [fixtureRaw, manifestRaw] = await Promise.all([
    readFile(fixturePath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  const fixture = SmartSearchGoldSetSchema.parse(JSON.parse(fixtureRaw) as unknown);
  const manifest = IdentitySchema.loose().parse(JSON.parse(manifestRaw) as unknown);
  if (
    JSON.stringify(fixture.corpus) !==
    JSON.stringify({
      corpus_hash: manifest.corpus_hash,
      corpus_id: manifest.corpus_id,
      manifest_version: manifest.manifest_version,
      mapping_version: manifest.mapping_version,
    })
  )
    throw new Error("Smart-search gold corpus identity does not match the source manifest.");
  return fixture;
}

export interface SmartSearchRatioResult {
  candidate_recall_at_30: number;
  ratio: 0.25 | 0.5 | 0.75;
  recovered_expected: number;
  total_expected: number;
}

export async function evaluateSmartSearchRatios(
  fixture: SmartSearchGoldSet,
  service: Pick<KnowledgeSearchService, "searchCases" | "searchLectures">,
): Promise<{
  approval_status: SmartSearchGoldSet["approval"]["status"];
  recommended_ratio: 0.25 | 0.5 | 0.75;
  release_gate_passed: boolean;
  results: SmartSearchRatioResult[];
  technical_gate_passed: boolean;
}> {
  const ratios = [0.25, 0.5, 0.75] as const;
  const results: SmartSearchRatioResult[] = [];
  for (const ratio of ratios) {
    let recovered = 0;
    let total = 0;
    for (const query of fixture.queries) {
      const page =
        query.target === "lectures"
          ? await service.searchLectures({
              hybrid: { embedder: "knowledge_zh_v1", semanticRatio: ratio },
              limit: 30,
              query: query.retrieval_query,
            })
          : await service.searchCases({
              hybrid: { embedder: "knowledge_zh_v1", semanticRatio: ratio },
              limit: 30,
              query: query.retrieval_query,
            });
      const returned = new Set(
        page.hits.map((hit) =>
          query.target === "lectures"
            ? "lecture_id" in hit.document
              ? hit.document.lecture_id
              : ""
            : "case_id" in hit.document
              ? hit.document.case_id
              : "",
        ),
      );
      recovered += query.expected_hit_ids.filter((id) => returned.has(id)).length;
      total += query.expected_hit_ids.length;
    }
    results.push({
      candidate_recall_at_30: total === 0 ? 0 : recovered / total,
      ratio,
      recovered_expected: recovered,
      total_expected: total,
    });
  }
  const recommended = [...results].sort(
    (left, right) =>
      right.candidate_recall_at_30 - left.candidate_recall_at_30 ||
      Math.abs(left.ratio - 0.5) - Math.abs(right.ratio - 0.5),
  )[0];
  if (recommended === undefined)
    throw new Error("Smart-search ratio evaluation returned no results.");
  const technical =
    recommended.candidate_recall_at_30 >= fixture.thresholds.candidate_recall_at_30_min;
  return {
    approval_status: fixture.approval.status,
    recommended_ratio: recommended.ratio,
    release_gate_passed: technical && fixture.approval.status === "approved",
    results,
    technical_gate_passed: technical,
  };
}
