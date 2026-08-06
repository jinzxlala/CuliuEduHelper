import {
  KnowledgeCitationSchema,
  listKnowledgeAnalysisReports,
  readKnowledgeConversation,
  readKnowledgeWorkspace,
} from "@culiu/knowledge-analysis";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AnalysisConversation } from "../../../../../components/analysis-conversation";
import { AnalysisNewConversationButton } from "../../../../../components/analysis-new-conversation-button";
import { AnalysisSourceSidebar } from "../../../../../components/analysis-source-sidebar";
import { requireActiveSessionPrincipal } from "../../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../../lib/database";

export default async function ConversationPage({
  params,
}: Readonly<{
  params: Promise<{ conversationId: string; workspaceId: string }>;
}>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const { conversationId, workspaceId } = await params;
  try {
    const database = getDatabaseClient().database;
    const [workspace, state, reports] = await Promise.all([
      readKnowledgeWorkspace(database, principal.id, workspaceId),
      readKnowledgeConversation(database, principal.id, workspaceId, conversationId),
      listKnowledgeAnalysisReports(database, principal.id, workspaceId, conversationId),
    ]);
    const editable = workspace.workspace.status === "active" && workspace.role !== "viewer";
    const hasMessages = state.messages.length > 0;
    return (
      <main className="app-shell analysis-workspace-shell">
        <nav aria-label="工作区导航" className="workspace-toolbar">
          <div>
            <Link className="secondary-button button-link compact-button" href="/analysis">
              ← 所有工作区
            </Link>
            <span>{workspace.workspace.name}</span>
          </div>
          <div className="page-action-row">
            {editable ? <AnalysisNewConversationButton workspaceId={workspaceId} /> : null}
            {workspace.role === "owner" ? (
              <Link
                className="secondary-button button-link"
                href={`/analysis/${workspaceId}/sharing`}
              >
                管理共享
              </Link>
            ) : null}
          </div>
        </nav>
        <header className="conversation-header">
          <div>
            <p className="eyebrow">当前对话</p>
            <h1>{state.conversation.title}</h1>
            <p className="page-lead">当前对话只使用自己的历史记录与本工作区冻结资料。</p>
          </div>
          <div className="page-action-row report-entry-actions">
            {editable && hasMessages ? (
              <Link
                className="primary-button button-link"
                href={`/analysis/${workspaceId}/conversations/${conversationId}/reports/new`}
              >
                生成单页分析
              </Link>
            ) : null}
            {reports.length > 0 ? (
              <Link
                className="secondary-button button-link"
                href={`/analysis/${workspaceId}/conversations/${conversationId}/reports`}
              >
                历史分析（{reports.length}）
              </Link>
            ) : null}
          </div>
        </header>
        <div className="conversation-switcher" aria-label="切换对话">
          {workspace.conversations
            .filter((item) => item.status === "active")
            .map((item) => (
              <Link
                aria-current={item.id === conversationId ? "page" : undefined}
                href={`/analysis/${workspaceId}/conversations/${item.id}`}
                key={item.id}
              >
                {item.title}
              </Link>
            ))}
        </div>
        <div className="analysis-conversation-layout">
          <AnalysisSourceSidebar
            editable={editable}
            sources={workspace.sources.map((item) => ({
              contentHash: item.contentHash,
              id: item.id,
              removedAt: item.removedAt?.toISOString() ?? null,
              sourceId: item.sourceId,
              sourceType: item.sourceType,
            }))}
            workspaceId={workspaceId}
          />
          <section className="analysis-chat-main">
            <AnalysisConversation
              conversationId={conversationId}
              initial={{
                messages: state.messages.map((message) => ({
                  citations: KnowledgeCitationSchema.array().parse(message.citations),
                  contentMarkdown: message.contentMarkdown,
                  id: message.id,
                  role: message.role,
                  sequence: message.sequence,
                })),
                runs: state.runs,
              }}
              role={workspace.role}
              workspaceId={workspaceId}
            />
          </section>
        </div>
      </main>
    );
  } catch {
    notFound();
  }
}
