import { z } from "zod";

const KnowledgeStatisticsRowSchema = z
  .object({
    case_count: z.number().int().nonnegative(),
    lecture_count: z.number().int().nonnegative(),
  })
  .strict();

export interface KnowledgeStatistics {
  cases: number;
  lectures: number;
}

export interface KnowledgeStatisticsReader {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

export async function loadPublishedKnowledgeStatistics(
  reader: KnowledgeStatisticsReader,
): Promise<KnowledgeStatistics> {
  const result = await reader.query(
    `select lecture_count, case_count
       from knowledge_import_batch
      where is_current = true and status = 'published'
      limit 1`,
  );
  const candidate = result.rows[0];
  if (candidate === undefined) return { cases: 0, lectures: 0 };
  const row = KnowledgeStatisticsRowSchema.parse(candidate);
  return { cases: row.case_count, lectures: row.lecture_count };
}
