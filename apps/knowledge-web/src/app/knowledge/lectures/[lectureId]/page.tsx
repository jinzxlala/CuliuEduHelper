import {
  EvidenceNotFoundError,
  LectureDocumentSchema,
  MeilisearchDocumentIdSchema,
} from "@culiu/search";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { requireActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getKnowledgeSearchService } from "../../../../lib/knowledge-search";

export const dynamic = "force-dynamic";

function DetailSection({
  children,
  title,
}: Readonly<{ children: string; title: string }>): JSX.Element | null {
  if (children.trim() === "") return null;
  return (
    <section className="detail-section">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

export default async function LectureDetailPage({
  params,
}: Readonly<{ params: Promise<{ lectureId: string }> }>): Promise<JSX.Element> {
  await requireActiveSessionPrincipal();
  const { lectureId } = await params;
  if (!MeilisearchDocumentIdSchema.safeParse(lectureId).success) notFound();

  let lecture;
  try {
    lecture = LectureDocumentSchema.parse(
      await getKnowledgeSearchService().getEvidence({ kind: "lecture", lecture_id: lectureId }),
    );
  } catch (error) {
    if (error instanceof EvidenceNotFoundError) notFound();
    throw error;
  }

  const transcriptHref = `/search?type=transcripts&lecture=${encodeURIComponent(lecture.lecture_id)}`;
  return (
    <main className="detail-shell">
      <header className="detail-nav">
        <Link href="/search">← 返回搜索</Link>
        <span>讲座证据</span>
      </header>
      <article className="detail-card">
        <p className="eyebrow">Lecture · {lecture.lecture_id}</p>
        <h1>{lecture.title}</h1>
        <dl className="metadata-grid">
          <div>
            <dt>日期</dt>
            <dd>{lecture.date ?? "待确认"}</dd>
          </div>
          <div>
            <dt>机构</dt>
            <dd>{lecture.organization ?? "待确认"}</dd>
          </div>
          <div>
            <dt>讲者</dt>
            <dd>{lecture.speakers.join("、") || "待确认"}</dd>
          </div>
          <div>
            <dt>学校 / 专业</dt>
            <dd>{[...lecture.schools, ...lecture.majors].join("、") || "未标注"}</dd>
          </div>
        </dl>
        <DetailSection title="内容摘要">{lecture.summary}</DetailSection>
        <DetailSection title="趋势观察">{lecture.trend_text}</DetailSection>
        <DetailSection title="AI 与跨学科">{lecture.ai_cross_disciplinary_text}</DetailSection>
        <DetailSection title="失败与风险">{lecture.failure_text}</DetailSection>
        <section className="source-box">
          <div>
            <span>逻辑来源路径</span>
            <code>{lecture.source_path}</code>
          </div>
          <p>此处展示索引中的来源定位，不提供本机绝对路径，也不改写原始文件。</p>
        </section>
        <div className="detail-actions">
          <Link href={`/search?type=cases&lecture=${encodeURIComponent(lecture.lecture_id)}`}>
            查看关联案例
          </Link>
          <Link href={transcriptHref}>查看逐字稿证据</Link>
        </div>
      </article>
    </main>
  );
}
