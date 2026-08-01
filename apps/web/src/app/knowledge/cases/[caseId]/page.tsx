import {
  CaseDocumentSchema,
  EvidenceNotFoundError,
  LectureDocumentSchema,
  MeilisearchDocumentIdSchema,
} from "@culiu/search";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { requireActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getKnowledgeSearchService } from "../../../../lib/knowledge-search";
import { formatTimestamp } from "../../../../lib/search-page-state";

export const dynamic = "force-dynamic";

function TextRow({ label, value }: Readonly<{ label: string; value: string }>): JSX.Element | null {
  if (value.trim() === "") return null;
  return (
    <section className="detail-section">
      <h2>{label}</h2>
      <p>{value}</p>
    </section>
  );
}

export default async function CaseDetailPage({
  params,
}: Readonly<{ params: Promise<{ caseId: string }> }>): Promise<JSX.Element> {
  await requireActiveSessionPrincipal();
  const { caseId } = await params;
  if (!MeilisearchDocumentIdSchema.safeParse(caseId).success) notFound();

  const reader = getKnowledgeSearchService();
  let item;
  let lecture;
  try {
    item = CaseDocumentSchema.parse(await reader.getEvidence({ kind: "case", case_id: caseId }));
    lecture = LectureDocumentSchema.parse(
      await reader.getEvidence({ kind: "lecture", lecture_id: item.lecture_id }),
    );
  } catch (error) {
    if (error instanceof EvidenceNotFoundError) notFound();
    throw error;
  }

  return (
    <main className="detail-shell">
      <header className="detail-nav">
        <Link href="/search?type=cases">← 返回案例搜索</Link>
        <span>匿名案例证据</span>
      </header>
      <article className="detail-card">
        <p className="eyebrow">Case · {item.case_id}</p>
        <h1>{item.academic_label || item.case_type}</h1>
        <dl className="metadata-grid">
          <div>
            <dt>案例性质</dt>
            <dd>{item.case_type}</dd>
          </div>
          <div>
            <dt>课程体系</dt>
            <dd>{item.curriculum_system ?? "待确认"}</dd>
          </div>
          <div>
            <dt>学校 / 专业</dt>
            <dd>{[...item.schools, item.major].filter(Boolean).join("、") || "未标注"}</dd>
          </div>
          <div>
            <dt>证据可信度</dt>
            <dd>{item.confidence}</dd>
          </div>
        </dl>
        <TextRow label="背景" value={item.background} />
        <TextRow label="录取结果" value={item.admission_result} />
        <TextRow label="研究方法" value={item.research_methods.join("、")} />
        <TextRow label="活动类型" value={item.activity_types.join("、")} />
        <TextRow label="AI 方向" value={item.ai_domains.join("、")} />
        <section className="boundary-card">
          <h2>证据边界</h2>
          <p>{item.evidence_boundary || "分析稿未提供额外的证据边界说明。"}</p>
          <p>这是讲座中的匿名案例，仅供知识库参考，不能作为任何真实学生的已确认事实。</p>
        </section>
        <section className="detail-section">
          <h2>时间戳引用</h2>
          {item.timestamp_refs.length === 0 ? (
            <p className="muted-notice">当前逐字稿尚未通过独立隐私审核，因此不展示或推测时间戳。</p>
          ) : (
            <ul className="evidence-links">
              {item.timestamp_refs.map((reference) => (
                <li key={reference.segment_id}>
                  <Link href={`/knowledge/transcripts/${encodeURIComponent(reference.segment_id)}`}>
                    {formatTimestamp(reference.start_seconds)}—
                    {formatTimestamp(reference.end_seconds)}
                  </Link>
                  <code>{reference.source_path}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="source-box">
          <div>
            <span>来源讲座</span>
            <Link href={`/knowledge/lectures/${encodeURIComponent(lecture.lecture_id)}`}>
              {lecture.title}
            </Link>
          </div>
          <code>{lecture.source_path}</code>
        </section>
      </article>
    </main>
  );
}
