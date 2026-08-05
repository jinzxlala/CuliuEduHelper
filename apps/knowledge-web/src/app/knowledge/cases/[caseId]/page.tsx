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

const confidenceLabels: Readonly<Record<string, string>> = {
  high: "高",
  low: "低",
  medium: "中",
  unknown: "待确认",
};

function TextRow({ label, value }: Readonly<{ label: string; value: string }>): JSX.Element | null {
  if (value.trim() === "") return null;
  return (
    <section className="detail-section">
      <h2>{label}</h2>
      <p>{value}</p>
    </section>
  );
}

function ListSection({
  label,
  values,
}: Readonly<{ label: string; values: readonly string[] }>): JSX.Element | null {
  if (values.length === 0) return null;
  return (
    <section className="detail-section">
      <h2>{label}</h2>
      <ul className="case-detail-list">
        {values.map((value, index) => (
          <li key={`${label}-${String(index)}`}>{value}</li>
        ))}
      </ul>
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
        <p className="eyebrow">匿名学生案例 · {item.case_id}</p>
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
        {item.profile_summary === "" ? null : (
          <section className="case-profile-summary">
            <span>案例概览</span>
            <p>{item.profile_summary}</p>
          </section>
        )}
        <TextRow label="背景" value={item.background} />
        <TextRow label="录取结果" value={item.admission_result} />
        <ListSection label="可核实事实" values={item.verified_facts} />
        <ListSection label="发展路径" values={item.development_path} />
        {item.core_projects.length === 0 ? null : (
          <section className="detail-section">
            <h2>核心项目与活动</h2>
            <div className="case-project-grid">
              {item.core_projects.map((project, index) => (
                <article className="case-project-card" key={`${project.name}-${String(index)}`}>
                  <h3>{project.name}</h3>
                  {project.role === "" ? null : (
                    <p>
                      <strong>角色：</strong>
                      {project.role}
                    </p>
                  )}
                  {project.actions.length === 0 ? null : (
                    <p>
                      <strong>行动：</strong>
                      {project.actions.join("；")}
                    </p>
                  )}
                  {project.methods.length === 0 ? null : (
                    <p>
                      <strong>方法：</strong>
                      {project.methods.join("；")}
                    </p>
                  )}
                  {project.outputs.length === 0 ? null : (
                    <p>
                      <strong>产出：</strong>
                      {project.outputs.join("；")}
                    </p>
                  )}
                  {project.impact === "" ? null : (
                    <p>
                      <strong>影响：</strong>
                      {project.impact}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        <ListSection label="核心优势" values={item.core_strengths} />
        <ListSection label="申请策略" values={item.application_strategy} />
        <ListSection label="顾问启示" values={item.advisor_insights} />
        <ListSection label="分析性判断（非直接事实）" values={item.interpretations} />
        <TextRow label="研究方法" value={item.research_methods.join("、")} />
        <TextRow label="活动类型" value={item.activity_types.join("、")} />
        <TextRow label="AI 方向" value={item.ai_domains.join("、")} />
        {item.evidence_points.length === 0 ? null : (
          <section className="detail-section">
            <h2>逐字稿证据对照</h2>
            <div className="case-evidence-list">
              {item.evidence_points.map((point, index) => (
                <article key={`${point.source_locator}-${String(index)}`}>
                  <div>
                    <strong>{point.claim}</strong>
                    <span>{confidenceLabels[point.confidence] ?? "待确认"}</span>
                  </div>
                  <p>{point.evidence}</p>
                  <code>{point.source_locator || "未提供定位"}</code>
                </article>
              ))}
            </div>
          </section>
        )}
        <ListSection label="仍需核实" values={item.missing_information} />
        <section className="boundary-card">
          <h2>证据边界</h2>
          <p>{item.evidence_boundary || "分析稿未提供额外的证据边界说明。"}</p>
          <p>
            这是讲座中的匿名案例，仅供顾问检索和方法参考，不能作为任何真实学生的已确认事实，也不能把录取结果解释为单一活动的因果结果。
          </p>
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
