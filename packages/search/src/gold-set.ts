import { readFile } from "node:fs/promises";

import { z } from "zod";

import { MeilisearchDocumentIdSchema } from "./documents.js";
import {
  CaseSearchInputSchema,
  LectureSearchInputSchema,
  TranscriptSearchInputSchema,
} from "./search-contracts.js";

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u, "expected a semantic version");
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "expected a lowercase SHA-256 hash");
const GoldQueryIdSchema = z
  .string()
  .regex(/^gold_(?:lecture|case|transcript)_\d{3}$/u, "invalid gold query identifier");
const UniqueDocumentIdsSchema = z
  .array(MeilisearchDocumentIdSchema)
  .min(1)
  .max(50)
  .refine((values) => new Set(values).size === values.length, {
    message: "document IDs must be unique",
  });
const OptionalUniqueDocumentIdsSchema = z
  .array(MeilisearchDocumentIdSchema)
  .max(50)
  .default([])
  .refine((values) => new Set(values).size === values.length, {
    message: "document IDs must be unique",
  });

export const GoldQueryTagSchema = z.enum([
  "alias_or_abbreviation",
  "chinese_tokenization",
  "evidence_boundary",
  "exact_phrase",
  "field_weight",
  "hard_filter",
  "mixed_language",
  "negative_condition",
]);

const UniqueTagsSchema = z
  .array(GoldQueryTagSchema)
  .min(1)
  .max(8)
  .refine((values) => new Set(values).size === values.length, {
    message: "query tags must be unique",
  });

const GoldQueryCommonShape = {
  critical: z.boolean(),
  description: z.string().trim().min(1).max(500),
  expected_hit_ids: UniqueDocumentIdsSchema,
  forbidden_hit_ids: OptionalUniqueDocumentIdsSchema,
  id: GoldQueryIdSchema,
  minimum_expected_hits: z.number().int().min(1).max(5).default(1),
  notes: z.string().trim().min(1).max(1_000).optional(),
  tags: UniqueTagsSchema,
} as const;

const LectureGoldQuerySchema = z
  .object({
    ...GoldQueryCommonShape,
    input: LectureSearchInputSchema,
    target: z.literal("lectures"),
  })
  .strict();

const CaseGoldQuerySchema = z
  .object({
    ...GoldQueryCommonShape,
    input: CaseSearchInputSchema,
    target: z.literal("cases"),
  })
  .strict();

const TranscriptGoldQuerySchema = z
  .object({
    ...GoldQueryCommonShape,
    input: TranscriptSearchInputSchema,
    target: z.literal("transcript_segments"),
  })
  .strict();

export const SearchGoldQuerySchema = z
  .discriminatedUnion("target", [
    LectureGoldQuerySchema,
    CaseGoldQuerySchema,
    TranscriptGoldQuerySchema,
  ])
  .superRefine((query, context) => {
    if (query.minimum_expected_hits > query.expected_hit_ids.length) {
      context.addIssue({
        code: "custom",
        message: "minimum_expected_hits cannot exceed expected_hit_ids length",
        path: ["minimum_expected_hits"],
      });
    }

    const expectedPrefix =
      query.target === "lectures" ? "lecture_" : query.target === "cases" ? "case_" : "segment_";
    for (const [field, values] of [
      ["expected_hit_ids", query.expected_hit_ids],
      ["forbidden_hit_ids", query.forbidden_hit_ids],
    ] as const) {
      for (const [index, value] of values.entries()) {
        if (!value.startsWith(expectedPrefix)) {
          context.addIssue({
            code: "custom",
            message: `${field} must contain ${expectedPrefix} identifiers for ${query.target}`,
            path: [field, index],
          });
        }
      }
    }

    const expected = new Set(query.expected_hit_ids);
    for (const [index, value] of query.forbidden_hit_ids.entries()) {
      if (expected.has(value)) {
        context.addIssue({
          code: "custom",
          message: "an identifier cannot be both expected and forbidden",
          path: ["forbidden_hit_ids", index],
        });
      }
    }
  });

const GoldSetApprovalSchema = z.discriminatedUnion("status", [
  z
    .object({
      reviewed_at: z.null(),
      reviewed_by: z.null(),
      status: z.literal("draft"),
    })
    .strict(),
  z
    .object({
      reviewed_at: z.iso.datetime({ offset: true }),
      reviewed_by: z.string().trim().min(1).max(200),
      status: z.literal("approved"),
    })
    .strict(),
]);

export const SearchGoldSetSchema = z
  .object({
    approval: GoldSetApprovalSchema,
    corpus: z
      .object({
        corpus_hash: Sha256Schema,
        corpus_id: z.string().trim().min(1).max(200),
        manifest_version: SemverSchema,
        mapping_version: SemverSchema,
      })
      .strict(),
    drafted_at: z.iso.datetime({ offset: true }),
    drafted_by: z.literal("Code Agent"),
    fixture_id: z
      .string()
      .regex(/^[a-z0-9_-]+$/u)
      .max(200),
    fixture_version: SemverSchema,
    queries: z.array(SearchGoldQuerySchema).min(50).max(500),
    schema_version: z.literal("1.0.0"),
    thresholds: z
      .object({
        critical_hit_rate_min: z.literal(1),
        filter_accuracy_min: z.literal(1),
        p95_latency_ms_max: z.number().positive().max(500),
        top_5_hit_rate_min: z.number().min(0.85).max(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((goldSet, context) => {
    const ids = new Set<string>();
    const querySignatures = new Set<string>();
    let activeFilterCount = 0;
    for (const [index, query] of goldSet.queries.entries()) {
      if (ids.has(query.id)) {
        context.addIssue({
          code: "custom",
          message: "gold query IDs must be unique",
          path: ["queries", index, "id"],
        });
      }
      ids.add(query.id);

      const signature = JSON.stringify({ input: query.input, target: query.target });
      if (querySignatures.has(signature)) {
        context.addIssue({
          code: "custom",
          message: "gold queries must not duplicate the same target and search input",
          path: ["queries", index, "input"],
        });
      }
      querySignatures.add(signature);

      const hasActiveFilter = Object.values(query.input.filters).some((value) =>
        Array.isArray(value) ? value.length > 0 : value !== undefined,
      );
      if (hasActiveFilter) activeFilterCount += 1;
      if (query.tags.includes("hard_filter") !== hasActiveFilter) {
        context.addIssue({
          code: "custom",
          message: "hard_filter tags must exactly match queries with active filters",
          path: ["queries", index, "tags"],
        });
      }
    }
    if (!goldSet.queries.some((query) => query.critical)) {
      context.addIssue({
        code: "custom",
        message: "at least one critical query is required",
        path: ["queries"],
      });
    }
    if (activeFilterCount === 0) {
      context.addIssue({
        code: "custom",
        message: "at least one active hard-filter query is required",
        path: ["queries"],
      });
    }
    if (!goldSet.queries.some((query) => query.forbidden_hit_ids.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "at least one forbidden-result check is required",
        path: ["queries"],
      });
    }
  });

export type SearchGoldQuery = z.infer<typeof SearchGoldQuerySchema>;
export type SearchGoldSet = z.infer<typeof SearchGoldSetSchema>;

const SourceManifestIdentitySchema = z
  .object({
    corpus_hash: Sha256Schema,
    corpus_id: z.string().trim().min(1),
    manifest_version: SemverSchema,
    mapping_version: SemverSchema,
  })
  .loose();

export class GoldSetCorpusMismatchError extends Error {
  public constructor() {
    super("Search gold set corpus identity does not match the source manifest.");
    this.name = "GoldSetCorpusMismatchError";
  }
}

export function parseSearchGoldSet(untrustedValue: unknown): SearchGoldSet {
  return SearchGoldSetSchema.parse(untrustedValue);
}

export async function loadSearchGoldSet(path: string | URL): Promise<SearchGoldSet> {
  const serialized = await readFile(path, "utf8");
  return parseSearchGoldSet(JSON.parse(serialized) as unknown);
}

export function assertGoldSetMatchesSourceManifest(
  goldSet: SearchGoldSet,
  untrustedManifest: unknown,
): void {
  const manifest = SourceManifestIdentitySchema.parse(untrustedManifest);
  if (
    goldSet.corpus.corpus_id !== manifest.corpus_id ||
    goldSet.corpus.corpus_hash !== manifest.corpus_hash ||
    goldSet.corpus.mapping_version !== manifest.mapping_version ||
    goldSet.corpus.manifest_version !== manifest.manifest_version
  ) {
    throw new GoldSetCorpusMismatchError();
  }
}

export async function loadAndVerifySearchGoldSet(
  goldSetPath: string | URL,
  manifestPath: string | URL,
): Promise<SearchGoldSet> {
  const [goldSet, serializedManifest] = await Promise.all([
    loadSearchGoldSet(goldSetPath),
    readFile(manifestPath, "utf8"),
  ]);
  assertGoldSetMatchesSourceManifest(goldSet, JSON.parse(serializedManifest) as unknown);
  return goldSet;
}
