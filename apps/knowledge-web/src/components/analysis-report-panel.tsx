"use client";

import { useEffect, useState, type JSX } from "react";

interface ReportRow {
  id: string;
  safeErrorSummary: string | null;
  status: "queued" | "planning" | "computing" | "rendering" | "succeeded" | "failed";
  title: string;
  version: number;
}

const activeStatuses = new Set<ReportRow["status"]>([
  "queued",
  "planning",
  "computing",
  "rendering",
]);

export function AnalysisReportPanel({
  conversationId,
  initialReports,
  role,
  workspaceId,
}: Readonly<{
  conversationId: string;
  initialReports: ReportRow[];
  role: "owner" | "editor" | "viewer";
  workspaceId: string;
}>): JSX.Element {
  const [reports, setReports] = useState(initialReports);
  const [requirements, setRequirements] = useState("");
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/analysis/workspaces/${workspaceId}/conversations/${conversationId}/reports`;
  const active = reports.some((report) => activeStatuses.has(report.status));

  async function refresh(): Promise<void> {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取报告状态。");
    setReports((await response.json()) as ReportRow[]);
  }

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () =>
        void refresh().catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "报告状态读取失败。");
        }),
      1_500,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [active, endpoint]);

  async function submit(
    event: { preventDefault(): void },
    supersedesReportId?: string,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        requirements,
        ...(supersedesReportId === undefined ? {} : { supersedesReportId }),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      const payload = (await response.json()) as { message?: string };
      setError(payload.message ?? "无法创建报告任务。");
      return;
    }
    setRequirements("");
    await refresh();
  }

  return (
    <section className="report-panel">
      <h2>单页分析报告</h2>
      <p>
        报告统计由系统确定性计算；DeepSeek
        只负责组织论述与选择既有图表。每次生成都会冻结当前对话和工作区资料版本。
      </p>
      {role === "viewer" ? (
        <div className="notice">你可以预览和下载已有报告，但不能创建新报告。</div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="report-requirements">本次分析要求（可留空）</label>
          <textarea
            id="report-requirements"
            maxLength={4000}
            onChange={(event) => {
              setRequirements(event.target.value);
            }}
            placeholder="例如：重点比较案例方向，并明确样本边界。"
            rows={4}
            value={requirements}
          />
          <button disabled={active} type="submit">
            生成交互式报告
          </button>
        </form>
      )}
      {error === null ? null : <p className="error-text">{error}</p>}
      <div className="report-list">
        {reports.map((report) => (
          <article className="report-card" key={report.id}>
            <div>
              <strong>{report.title}</strong>
              <span>
                版本 {report.version} · {report.status}
              </span>
            </div>
            {report.status === "succeeded" ? (
              <>
                <iframe
                  sandbox="allow-scripts"
                  src={`/api/analysis/workspaces/${workspaceId}/reports/${report.id}/artifact?variant=interactive&download=0`}
                  title={`${report.title} 预览`}
                />
                <div className="button-row">
                  <a
                    className="button-link"
                    href={`/api/analysis/workspaces/${workspaceId}/reports/${report.id}/artifact?variant=interactive&download=1`}
                  >
                    下载交互版
                  </a>
                  <a
                    className="button-link secondary"
                    href={`/api/analysis/workspaces/${workspaceId}/reports/${report.id}/artifact?variant=static&download=1`}
                  >
                    下载静态归档版
                  </a>
                  {role === "viewer" ? null : (
                    <button
                      disabled={active}
                      onClick={(event) => void submit(event, report.id)}
                      type="button"
                    >
                      基于当前快照生成新版本
                    </button>
                  )}
                </div>
              </>
            ) : report.status === "failed" ? (
              <p className="error-text">{report.safeErrorSummary}</p>
            ) : (
              <div className="notice">报告任务正在运行……</div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
