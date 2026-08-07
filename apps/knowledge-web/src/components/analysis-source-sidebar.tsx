"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type JSX } from "react";

interface Source {
  contentHash: string;
  id: string;
  removedAt: string | null;
  sourceId: string;
  sourceType: "lecture" | "case";
}

export function AnalysisSourceSidebar({
  editable,
  sources,
  workspaceId,
}: Readonly<{ editable: boolean; sources: Source[]; workspaceId: string }>): JSX.Element {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSources = sources.filter((source) => source.removedAt === null);

  async function remove(sourceId: string): Promise<void> {
    setBusyId(sourceId);
    setError(null);
    try {
      const response = await fetch(
        `/api/analysis/workspaces/${workspaceId}/sources?sourceRecordId=${encodeURIComponent(sourceId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("无法移出这项资料。");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className="analysis-source-sidebar">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">冻结背景</p>
          <h2>背景资料</h2>
        </div>
        <span>{activeSources.length}/500</span>
      </div>
      {editable ? (
        <Link
          className="primary-button button-link full-width source-import-button"
          href={`/analysis/${workspaceId}/sources`}
        >
          引入资料
        </Link>
      ) : null}
      {activeSources.length === 0 ? (
        <div className="empty-state compact-empty-state">
          <p>尚未加入资料。</p>
          <Link href="/smart-search">前往智能搜索</Link>
        </div>
      ) : (
        <ul className="analysis-source-list">
          {activeSources.map((source) => (
            <li key={source.id}>
              <Link
                className="analysis-source-link"
                href={
                  source.sourceType === "lecture"
                    ? `/knowledge/lectures/${source.sourceId}`
                    : `/knowledge/cases/${source.sourceId}`
                }
                target="_blank"
              >
                <span>{source.sourceType === "lecture" ? "讲座" : "案例"}</span>
                <strong>{source.sourceId}</strong>
                <small>版本 {source.contentHash.slice(0, 10)}… · 新窗口查看</small>
              </Link>
              {editable ? (
                <button
                  className="text-button danger-text-button"
                  disabled={busyId === source.id}
                  onClick={() => void remove(source.id)}
                  type="button"
                >
                  移出
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : <p className="error-text">{error}</p>}
    </aside>
  );
}
