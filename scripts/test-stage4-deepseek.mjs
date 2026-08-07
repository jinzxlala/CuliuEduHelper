import { execFileSync } from "node:child_process";

import {
  createKnowledgeAnalysisAuthorizationContext,
  getActiveInteractivePrincipal,
} from "../packages/authorization/dist/index.js";
import {
  DeepSeekJsonModelProvider,
  parseDeepSeekGatewayConfig,
} from "../packages/ai/dist/index.js";
import { createDatabaseClient, parseDatabaseConfig } from "../packages/database/dist/index.js";
import {
  executeKnowledgeSmartSearch,
  prepareKnowledgeSmartSearch,
  readKnowledgeSmartSearch,
} from "../packages/knowledge-analysis/dist/index.js";
import {
  createMeilisearchClient,
  KnowledgeSearchService,
  parseMeilisearchSearchConfig,
} from "../packages/search/dist/index.js";

const acceptance = [
  { expectedIntent: "catalog_browse", prompt: "帮我检索所有2025年内的讲座" },
  {
    expectedIntent: "catalog_browse",
    prompt: "帮我检索所有2025年内的讲座和学生案例",
  },
  { expectedIntent: "semantic_search", prompt: "查找AI与医疗相关的讲座和案例" },
  { expectedIntent: "count", prompt: "2025年共有多少场讲座" },
  { expectedIntent: "analysis_required", prompt: "AI案例占全部案例的比例" },
];

const databaseClient = createDatabaseClient(parseDatabaseConfig());

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const account = await databaseClient.pool.query(
    `select id
       from app_user
      where active = true and role in ('admin', 'advisor')
      order by case role when 'admin' then 0 else 1 end, created_at
      limit 1`,
  );
  const accountId = account.rows[0]?.id;
  assert(
    typeof accountId === "string",
    "No active internal account is available for stage-four testing.",
  );
  const principal = await getActiveInteractivePrincipal(databaseClient.database, accountId);
  assert(principal !== null, "The selected stage-four test account is not active.");
  const authorization = await createKnowledgeAnalysisAuthorizationContext(
    databaseClient.database,
    principal,
  );
  const provider = new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig());
  const search = new KnowledgeSearchService({
    client: createMeilisearchClient(parseMeilisearchSearchConfig()),
  });
  const gitCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert(/^[0-9a-f]{40}$/u.test(gitCommitSha), "Git commit SHA is unavailable.");

  const checks = [];
  for (const [index, item] of acceptance.entries()) {
    const prepared = await prepareKnowledgeSmartSearch(
      databaseClient.database,
      authorization,
      { prompt: item.prompt },
      gitCommitSha,
    );
    const result = await executeKnowledgeSmartSearch(
      databaseClient.database,
      prepared.task,
      provider,
      search,
    );
    assert(
      result.intent === item.expectedIntent,
      `Acceptance query ${String(index + 1)} routed to ${result.intent}, expected ${item.expectedIntent}.`,
    );
    if (result.intent === "catalog_browse" || result.intent === "count") {
      assert(result.exactTotal !== null, `Acceptance query ${String(index + 1)} lacks exactTotal.`);
      assert(
        result.exactTotal === result.lectureCount + result.caseCount,
        `Acceptance query ${String(index + 1)} returned inconsistent deterministic counts.`,
      );
      assert(
        result.exactTotal > 0,
        `Acceptance query ${String(index + 1)} returned an empty deterministic catalog.`,
      );
    }
    if (result.intent === "semantic_search") {
      assert(result.results.length > 0, "Semantic acceptance query returned no results.");
      assert(result.results.length <= 20, "Semantic result limit exceeded 20.");
    }
    if (result.intent === "analysis_required") {
      assert(result.results.length === 0, "Analysis handoff unexpectedly returned result cards.");
    }
    if (index === 0 || index === 3) {
      assert(result.lectureCount > 0, "The 2025 lecture acceptance query found no lectures.");
      assert(result.caseCount === 0, "The lecture-only acceptance query returned cases.");
    }
    if (index === 1) {
      assert(
        result.lectureCount > 0 && result.caseCount > 0,
        "The combined 2025 catalog must contain both lectures and source-dated cases.",
      );
    }
    const firstPage = await readKnowledgeSmartSearch(
      databaseClient.database,
      principal.id,
      prepared.runId,
      1,
      20,
    );
    if (firstPage.totalPages > 1) {
      const secondPage = await readKnowledgeSmartSearch(
        databaseClient.database,
        principal.id,
        prepared.runId,
        2,
        20,
      );
      const firstIds = new Set(firstPage.resultReferences.map((entry) => entry.sourceId));
      assert(
        secondPage.resultReferences.every((entry) => !firstIds.has(entry.sourceId)),
        `Acceptance query ${String(index + 1)} repeated a frozen result across pages.`,
      );
    }
    const usage = await databaseClient.pool.query(
      `select prompt_tokens, completion_tokens, total_tokens
         from knowledge_smart_search_run
        where id = $1`,
      [prepared.runId],
    );
    checks.push({
      caseCount: result.caseCount,
      completionTokens: usage.rows[0]?.completion_tokens ?? 0,
      exactTotal: result.exactTotal,
      intent: result.intent,
      lectureCount: result.lectureCount,
      promptTokens: usage.rows[0]?.prompt_tokens ?? 0,
      query: index + 1,
      resultCount: result.results.length,
      totalPages: firstPage.totalPages,
      totalTokens: usage.rows[0]?.total_tokens ?? 0,
    });
  }
  process.stdout.write(`${JSON.stringify({ checks, status: "passed" })}\n`);
} finally {
  await databaseClient.close();
}
