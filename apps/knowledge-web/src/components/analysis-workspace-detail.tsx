import Link from "next/link";
import type { JSX } from "react";

import { AnalysisNewConversationButton } from "./analysis-new-conversation-button";
import { AnalysisSourceSidebar } from "./analysis-source-sidebar";

interface Source {
  contentHash: string;
  id: string;
  removedAt: string | null;
  sourceId: string;
  sourceType: "lecture" | "case";
}

export function AnalysisWorkspaceDetail({
  role,
  sources,
  status,
  workspaceId,
}: Readonly<{
  role: "owner" | "editor" | "viewer";
  sources: Source[];
  status: "active" | "archived";
  workspaceId: string;
}>): JSX.Element {
  const editable = status === "active" && role !== "viewer";
  return (
    <div className="workspace-empty-layout">
      <AnalysisSourceSidebar editable={editable} sources={sources} workspaceId={workspaceId} />
      <section className="analysis-panel empty-conversation-panel">
        <p className="eyebrow">对话</p>
        <h2>{status === "archived" ? "工作区已归档" : "还没有分析对话"}</h2>
        <p>
          {status === "archived"
            ? "该工作区保留为只读资料快照。"
            : "新对话无需命名。发送第一条消息后，DeepSeek 会根据内容生成简短主题。"}
        </p>
        <div className="page-action-row">
          {editable ? <AnalysisNewConversationButton workspaceId={workspaceId} /> : null}
          <Link className="secondary-button button-link" href="/analysis">
            返回工作区列表
          </Link>
          {role === "owner" ? (
            <Link
              className="secondary-button button-link"
              href={`/analysis/${workspaceId}/sharing`}
            >
              管理共享
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}
