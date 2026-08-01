import { resolve } from "node:path";

import { loadAndVerifySearchGoldSet } from "../gold-set.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const fixturePath = resolve(repositoryRoot, "knowledge/search-gold.v1.json");
const manifestPath = resolve(repositoryRoot, "knowledge/source-manifest.v1.json");

const goldSet = await loadAndVerifySearchGoldSet(fixturePath, manifestPath);

console.log(
  JSON.stringify({
    approval_status: goldSet.approval.status,
    corpus: goldSet.corpus,
    critical_queries: goldSet.queries.filter((query) => query.critical).length,
    fixture_id: goldSet.fixture_id,
    fixture_version: goldSet.fixture_version,
    query_count: goldSet.queries.length,
    status: "valid",
  }),
);
