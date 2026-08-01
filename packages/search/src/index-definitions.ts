import { z } from "zod";

import rawDefinitions from "../index-definitions.json" with { type: "json" };

const AttributeNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.]+$/u);

export const KnowledgeIndexDefinitionSchema = z
  .object({
    filterableAttributes: z.array(AttributeNameSchema),
    primaryKey: AttributeNameSchema,
    searchableAttributes: z.array(AttributeNameSchema),
    sortableAttributes: z.array(AttributeNameSchema),
    uid: z.enum(["lectures", "cases", "transcript_segments"]),
  })
  .strict();

const parsedDefinitions = z.array(KnowledgeIndexDefinitionSchema).length(3).parse(rawDefinitions);

function definition(
  uid: (typeof parsedDefinitions)[number]["uid"],
): (typeof parsedDefinitions)[number] {
  const result = parsedDefinitions.find((candidate) => candidate.uid === uid);
  if (result === undefined) {
    throw new Error(`Missing Meilisearch index definition: ${uid}`);
  }
  return result;
}

export const KNOWLEDGE_INDEX_DEFINITIONS = {
  cases: definition("cases"),
  lectures: definition("lectures"),
  transcriptSegments: definition("transcript_segments"),
} as const;

export const KnowledgeIndexNamesSchema = z
  .object({
    cases: z
      .string()
      .min(1)
      .max(450)
      .regex(/^[A-Za-z0-9_-]+$/u),
    lectures: z
      .string()
      .min(1)
      .max(450)
      .regex(/^[A-Za-z0-9_-]+$/u),
    transcriptSegments: z
      .string()
      .min(1)
      .max(450)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict()
  .refine((names) => new Set(Object.values(names)).size === 3, {
    message: "knowledge index names must be distinct",
  });

export type KnowledgeIndexNames = z.infer<typeof KnowledgeIndexNamesSchema>;

export const DEFAULT_KNOWLEDGE_INDEX_NAMES: KnowledgeIndexNames = {
  cases: KNOWLEDGE_INDEX_DEFINITIONS.cases.uid,
  lectures: KNOWLEDGE_INDEX_DEFINITIONS.lectures.uid,
  transcriptSegments: KNOWLEDGE_INDEX_DEFINITIONS.transcriptSegments.uid,
};
