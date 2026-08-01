import { resolve } from "node:path";

import { createMeilisearchClient, parseMeilisearchSearchConfig } from "../config.js";
import { evaluateSearchGoldSet } from "../gold-evaluator.js";
import { loadAndVerifySearchGoldSet } from "../gold-set.js";
import { KnowledgeSearchService } from "../service.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const fixturePath = resolve(repositoryRoot, "knowledge/search-gold.v1.json");
const manifestPath = resolve(repositoryRoot, "knowledge/source-manifest.v1.json");
const requireApproved = process.argv.includes("--require-approved");
const includeAllQueries = process.argv.includes("--full");

const goldSet = await loadAndVerifySearchGoldSet(fixturePath, manifestPath);
const client = createMeilisearchClient(parseMeilisearchSearchConfig());
const report = await evaluateSearchGoldSet(goldSet, new KnowledgeSearchService({ client }));
const failedQueries = report.queries.filter((query) => !query.passed);

console.log(
  JSON.stringify({
    approval_status: report.approval_status,
    corpus: report.corpus,
    evaluated_at: report.evaluated_at,
    failed_queries: includeAllQueries ? report.queries : failedQueries,
    fixture_id: report.fixture_id,
    fixture_version: report.fixture_version,
    metrics: report.metrics,
    release_gate_passed: report.release_gate_passed,
    technical_gate_passed: report.technical_gate_passed,
    thresholds: report.thresholds,
  }),
);

if (!report.technical_gate_passed) {
  process.exitCode = 1;
} else if (requireApproved && !report.release_gate_passed) {
  process.exitCode = 2;
}
