import { resolve } from "node:path";

import { createMeilisearchClient, parseMeilisearchSearchConfig } from "../config.js";
import { KnowledgeSearchService } from "../service.js";
import { evaluateSmartSearchRatios, loadSmartSearchGoldSet } from "../smart-gold.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const fixture = await loadSmartSearchGoldSet(
  resolve(repositoryRoot, "knowledge/smart-search-gold.v1.json"),
  resolve(repositoryRoot, "knowledge/source-manifest.v1.json"),
);
const report = await evaluateSmartSearchRatios(
  fixture,
  new KnowledgeSearchService({ client: createMeilisearchClient(parseMeilisearchSearchConfig()) }),
);
console.log(JSON.stringify(report));
if (!report.technical_gate_passed) process.exitCode = 1;
else if (process.argv.includes("--require-approved") && !report.release_gate_passed)
  process.exitCode = 2;
