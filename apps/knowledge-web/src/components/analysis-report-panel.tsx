"use client";

import Link from "next/link";
import { useEffect, useState, type JSX, type SyntheticEvent } from "react";

import { AnalysisReportCitationAudit } from "./analysis-report-citation-audit";

interface ReportRow {
  canCreatePresentationCopy: boolean;
  createdAt: string;
  id: string;
  safeErrorSummary: string | null;
  status: "queued" | "planning" | "computing" | "rendering" | "succeeded" | "failed";
  title: string;
  publicSafe: boolean;
  version: number;
}

const activeStatuses = new Set<ReportRow["status"]>([
  "queued",
  "planning",
  "computing",
  "rendering",
]);
const statusLabels: Record<ReportRow["status"], string> = {
  computing: "正在计算统计",
  failed: "生成失败",
  planning: "正在组织报告",
  queued: "等待处理",
  rendering: "正在生成页面",
  succeeded: "已完成",
};

export function AnalysisReportPanel({
  conversationId,
  initialReports,
  mode,
  role,
  workspaceId,
}: Readonly<{
  conversationId: string;
  initialReports: ReportRow[];
  mode: "create" | "history";
  role: "owner" | "editor" | "viewer";
  workspaceId: string;
}>): JSX.Element {
  const [reports, setReports] = useState(initialReports);
  const [requirements, setRequirements] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdReportId, setCreatedReportId] = useState<string | null>(null);
  const [copyingReportId, setCopyingReportId] = useState<string | null>(null);
  const endpoint = `/api/analysis/workspaces/${workspaceId}/conversations/${conversationId}/reports`;
  const active = reports.some((report) => activeStatuses.has(report.status));

  async function refresh(): Promise<void> {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取报告状态。");
    setReports((await response.json()) as ReportRow[]);
  }

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "报告状态读取失败。");
      });
    }, 1_500);
    return () => {
      window.clearInterval(timer);
    };
  }, [active, endpoint]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await fetch(endpoint, {
      body: JSON.stringify({ requirements }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json()) as { message?: string; reportId?: string };
    if (!response.ok || payload.reportId === undefined) {
      setError(payload.message ?? "无法创建报告任务。");
      return;
    }
    setCreatedReportId(payload.reportId);
    setRequirements("");
    await refresh();
  }

  async function createPresentationCopy(reportId: string): Promise<void> {
    setCopyingReportId(reportId);
    setError(null);
    try {
      const response = await fetch(
        `/api/analysis/workspaces/${workspaceId}/reports/${reportId}/presentation`,
        { method: "POST" },
      );
      const payload = (await response.json()) as { message?: string; reportId?: string };
      if (!response.ok || payload.reportId === undefined)
        throw new Error(payload.message ?? "无法生成对外展示副本。");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "对外展示副本生成失败。");
    } finally {
      setCopyingReportId(null);
    }
  }

  const createdReport =
    createdReportId === null ? undefined : reports.find((report) => report.id === createdReportId);
  const artifact = (reportId: string, variant: "interactive" | "static", download: 0 | 1): string =>
    `/api/analysis/workspaces/${workspaceId}/reports/${reportId}/artifact?variant=${variant}&download=${String(download)}`;

  if (mode === "create")
    return (
      <div className="report-create-layout">
        <section className="analysis-panel report-request-panel">
          <p className="eyebrow">新分析任务</p>
          <h2>补充本次分析要求</h2>
          <p className="muted-copy">可以留空，由 DeepSeek 根据当前对话和工作区资料组织报告。</p>
          {role === "viewer" ? (
            <div className="notice">只读成员不能创建新报告。</div>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              <label htmlFor="report-requirements">要求与限制（可留空）</label>
              <textarea
                id="report-requirements"
                maxLength={4000}
                onChange={(event) => {
                  setRequirements(event.target.value);
                }}
                placeholder="例如：重点比较案例方向，说明样本边界，并避免把相关性写成因果关系。"
                rows={7}
                value={requirements}
              />
              <button className="primary-button" disabled={active} type="submit">
                {active ? "报告生成中……" : "生成交互式报告"}
              </button>
            </form>
          )}
          {error === null ? null : <p className="error-text">{error}</p>}
        </section>
        <section className="analysis-panel report-preview-panel" aria-live="polite">
          <p className="eyebrow">生成结果</p>
          {createdReport === undefined ? (
            <div className="empty-state">
              <p>提交任务后，结果会显示在这里。</p>
            </div>
          ) : createdReport.status === "succeeded" ? (
            <>
              <div className="section-heading-row">
                <h2>{createdReport.title}</h2>
                <span>版本 {createdReport.version} · 对外安全引用</span>
              </div>
              <iframe
                sandbox="allow-scripts"
                src={artifact(createdReport.id, "interactive", 0)}
                title={`${createdReport.title} 预览`}
              />
              <div className="page-action-row">
                <a
                  className="primary-button button-link"
                  href={artifact(createdReport.id, "interactive", 1)}
                >
                  下载交互版
                </a>
                <a
                  className="secondary-button button-link"
                  href={artifact(createdReport.id, "static", 1)}
                >
                  下载静态归档版
                </a>
              </div>
              <AnalysisReportCitationAudit reportId={createdReport.id} workspaceId={workspaceId} />
            </>
          ) : createdReport.status === "failed" ? (
            <div className="notice error-notice">
              <p>{createdReport.safeErrorSummary ?? "报告生成失败。"}</p>
            </div>
          ) : (
            <div className="report-progress">
              <span className="status-dot" />
              <strong>{statusLabels[createdReport.status]}</strong>
            </div>
          )}
        </section>
      </div>
    );

  return (
    <section className="report-history-list">
      {reports.length === 0 ? (
        <div className="empty-state">
          <p>当前对话还没有分析报告。</p>
        </div>
      ) : (
        reports.map((report) => (
          <article className="report-history-card" key={report.id}>
            <div>
              <p className="eyebrow">版本 {report.version}</p>
              <h2>{report.title}</h2>
              <p>
                {new Date(report.createdAt).toLocaleString("zh-CN")} · {statusLabels[report.status]}
              </p>
              {report.status === "succeeded" ? (
                <p className={report.publicSafe ? "safe-status" : "legacy-status"}>
                  {report.publicSafe
                    ? "对外安全引用：下载文件不包含内部 ID"
                    : "旧版报告：下载文件仍可能包含内部 ID"}
                </p>
              ) : null}
              {report.status === "failed" ? (
                <p className="error-text">{report.safeErrorSummary}</p>
              ) : null}
            </div>
            {report.status === "succeeded" ? (
              <div className="report-history-actions">
                <a
                  className="primary-button button-link"
                  href={artifact(report.id, "interactive", 0)}
                  target="_blank"
                >
                  查看交互报告
                </a>
                <a
                  className="secondary-button button-link"
                  href={artifact(report.id, "interactive", 1)}
                >
                  下载交互版
                </a>
                <a className="secondary-button button-link" href={artifact(report.id, "static", 1)}>
                  下载静态版
                </a>
                {report.canCreatePresentationCopy && role !== "viewer" ? (
                  <button
                    className="secondary-button"
                    disabled={copyingReportId !== null}
                    onClick={() => void createPresentationCopy(report.id)}
                    type="button"
                  >
                    {copyingReportId === report.id ? "正在生成……" : "生成对外展示副本"}
                  </button>
                ) : null}
              </div>
            ) : null}
            {report.status === "succeeded" ? (
              <AnalysisReportCitationAudit reportId={report.id} workspaceId={workspaceId} />
            ) : null}
          </article>
        ))
      )}
      {error === null ? null : <p className="error-text">{error}</p>}
      {role === "viewer" ? null : (
        <Link
          className="primary-button button-link"
          href={`/analysis/${workspaceId}/conversations/${conversationId}/reports/new`}
        >
          生成新的分析报告
        </Link>
      )}
    </section>
  );
}
