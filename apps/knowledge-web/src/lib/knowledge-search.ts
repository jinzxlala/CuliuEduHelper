import "server-only";

import {
  KnowledgeSearchService,
  createMeilisearchClient,
  parseMeilisearchSearchConfig,
} from "@culiu/search";

let service: KnowledgeSearchService | undefined;

export function getKnowledgeSearchService(): KnowledgeSearchService {
  service ??= new KnowledgeSearchService({
    client: createMeilisearchClient(parseMeilisearchSearchConfig()),
  });
  return service;
}
