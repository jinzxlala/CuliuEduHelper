"use client";

import Link from "next/link";
import { useState, type JSX } from "react";

interface CitationAuditRow {
  contentHash: string;
  publicDescription: string;
  publicLabel: string;
  sourceId: string;
  sourceType: "lecture" | "case";
}

export function AnalysisReportCitationAudit({
  reportId,
  workspaceId,
}: Readonly<{ reportId: string; workspaceId: string }>): JSX.Element {
  const contentId = `citation-audit-${reportId}`;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<CitationAuditRow[] | null>(null);

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (rows !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/analysis/workspaces/${workspaceId}/reports/${reportId}/citations`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("无法读取内部引用映射。");
      setRows((await response.json()) as CitationAuditRow[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "内部引用映射读取失败。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="citation-audit-panel">
      <button
        aria-controls={contentId}
        aria-expanded={open}
        className="secondary-button compact-button"
        onClick={() => void toggle()}
        type="button"
      >
        {open ? "收起内部引用核验" : "内部引用核验"}
      </button>
      {open ? (
        <div className="citation-audit-content" id={contentId}>
          <p className="muted-copy">
            以下映射仅供登录后的内部核验，不会进入交互版或静态版下载文件。
          </p>
          {loading ? <p>正在读取引用……</p> : null}
          {error === null ? null : <p className="error-text">{error}</p>}
          {rows?.length === 0 ? <p>这份报告没有引用具体资料。</p> : null}
          {rows === null || rows.length === 0 ? null : (
            <div className="citation-audit-list">
              {rows.map((row) => (
                <article className="citation-audit-row" key={`${row.sourceType}:${row.sourceId}`}>
                  <div>
                    <strong>{row.publicLabel}</strong>
                    {row.publicDescription === "" ? null : <span>{row.publicDescription}</span>}
                  </div>
                  <div className="citation-audit-technical">
                    <code>{row.sourceId}</code>
                    <small>版本 {row.contentHash.slice(0, 12)}…</small>
                  </div>
                  <Link
                    className="text-button"
                    href={
                      row.sourceType === "lecture"
                        ? `/knowledge/lectures/${row.sourceId}`
                        : `/knowledge/cases/${row.sourceId}`
                    }
                    target="_blank"
                  >
                    查看内部来源 ↗
                  </Link>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
