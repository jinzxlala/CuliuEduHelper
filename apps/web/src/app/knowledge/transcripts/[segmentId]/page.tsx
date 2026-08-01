import {
  EvidenceNotFoundError,
  LectureDocumentSchema,
  MeilisearchDocumentIdSchema,
  TranscriptSegmentDocumentSchema,
} from "@culiu/search";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { getKnowledgeSearchService } from "../../../../lib/knowledge-search";
import { formatTimestamp } from "../../../../lib/search-page-state";

export const dynamic = "force-dynamic";

export default async function TranscriptDetailPage({
  params,
}: Readonly<{ params: Promise<{ segmentId: string }> }>): Promise<JSX.Element> {
  const { segmentId } = await params;
  if (!MeilisearchDocumentIdSchema.safeParse(segmentId).success) notFound();

  const reader = getKnowledgeSearchService();
  let segment;
  let lecture;
  try {
    segment = TranscriptSegmentDocumentSchema.parse(
      await reader.getEvidence({ kind: "transcript_segment", segment_id: segmentId }),
    );
    lecture = LectureDocumentSchema.parse(
      await reader.getEvidence({ kind: "lecture", lecture_id: segment.lecture_id }),
    );
  } catch (error) {
    if (error instanceof EvidenceNotFoundError) notFound();
    throw error;
  }

  return (
    <main className="detail-shell">
      <header className="detail-nav">
        <Link href="/search?type=transcripts">← 返回逐字稿搜索</Link>
        <span>逐字稿原始证据</span>
      </header>
      <article className="detail-card">
        <p className="eyebrow">Transcript · {segment.segment_id}</p>
        <h1>{segment.section ?? "未标章节"}</h1>
        <div className="timestamp-display">
          {formatTimestamp(segment.start_seconds)}—{formatTimestamp(segment.end_seconds)}
        </div>
        <blockquote className="transcript-text">{segment.text}</blockquote>
        <section className="source-box">
          <div>
            <span>来源讲座</span>
            <Link href={`/knowledge/lectures/${encodeURIComponent(lecture.lecture_id)}`}>
              {lecture.title}
            </Link>
          </div>
          <code>{segment.source_path}</code>
        </section>
        {segment.case_ids.length === 0 ? null : (
          <section className="detail-section">
            <h2>关联案例</h2>
            <ul className="evidence-links">
              {segment.case_ids.map((caseId) => (
                <li key={caseId}>
                  <Link href={`/knowledge/cases/${encodeURIComponent(caseId)}`}>{caseId}</Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </main>
  );
}
