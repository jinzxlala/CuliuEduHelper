import {
  createMeilisearchClient,
  KnowledgeSearchService,
  parseMeilisearchSearchConfig,
} from "@culiu/search";

async function main(): Promise<void> {
  const service = new KnowledgeSearchService({
    client: createMeilisearchClient(parseMeilisearchSearchConfig()),
  });
  const [lectures, cases, filteredCases, transcripts] = await Promise.all([
    service.searchLectures({ query: "美高", limit: 5 }),
    service.searchCases({ query: "心理健康", limit: 5 }),
    service.searchCases({
      query: "气候",
      filters: { caseTypes: ["学生录取案例"] },
      limit: 5,
    }),
    service.searchTranscriptSegments({ query: "学生", limit: 5 }),
  ]);
  const lecture = lectures.hits[0]?.document;
  const caseDocument = cases.hits[0]?.document ?? filteredCases.hits[0]?.document;
  if (lecture === undefined || caseDocument === undefined) {
    throw new Error("Chinese smoke queries did not return both lecture and case evidence.");
  }
  const [lectureEvidence, caseEvidence] = await Promise.all([
    service.getEvidence({ kind: "lecture", lecture_id: lecture.lecture_id }),
    service.getEvidence({ kind: "case", case_id: caseDocument.case_id }),
  ]);
  if (transcripts.estimatedTotalHits !== 0 || transcripts.hits.length !== 0) {
    throw new Error("Transcript privacy gate failed: transcript search returned indexed content.");
  }
  process.stdout.write(
    `${JSON.stringify({
      caseEvidenceId: "case_id" in caseEvidence ? caseEvidence.case_id : null,
      caseHits: cases.estimatedTotalHits,
      filteredCaseHits: filteredCases.estimatedTotalHits,
      lectureEvidenceId: "lecture_id" in lectureEvidence ? lectureEvidence.lecture_id : null,
      lectureHits: lectures.estimatedTotalHits,
      transcriptHits: transcripts.estimatedTotalHits,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Knowledge import smoke test failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
