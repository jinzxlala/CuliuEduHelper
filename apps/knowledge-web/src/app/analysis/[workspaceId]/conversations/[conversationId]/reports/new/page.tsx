import {
  listKnowledgeAnalysisReports,
  readKnowledgeConversation,
  readKnowledgeWorkspace,
} from "@culiu/knowledge-analysis";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AnalysisReportPanel } from "../../../../../../../components/analysis-report-panel";
import { requireActiveSessionPrincipal } from "../../../../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../../../../lib/database";

export default async function NewReportPage({
  params,
}: Readonly<{
  params: Promise<{ conversationId: string; workspaceId: string }>;
}>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const { conversationId, workspaceId } = await params;
  try {
    const database = getDatabaseClient().database;
    const [workspace, conversation, reports] = await Promise.all([
      readKnowledgeWorkspace(database, principal.id, workspaceId),
      readKnowledgeConversation(database, principal.id, workspaceId, conversationId),
      listKnowledgeAnalysisReports(database, principal.id, workspaceId, conversationId),
    ]);
    if (conversation.messages.length === 0) notFound();
    return (
      <main className="app-shell">
        <p className="eyebrow">单页分析</p>
        <h1>生成交互式分析报告</h1>
        <p className="page-lead">{conversation.conversation.title}</p>
        <div className="page-action-row">
          <Link
            className="secondary-button button-link"
            href={`/analysis/${workspaceId}/conversations/${conversationId}`}
          >
            ← 返回对话
          </Link>
          {reports.length > 0 ? (
            <Link
              className="secondary-button button-link"
              href={`/analysis/${workspaceId}/conversations/${conversationId}/reports`}
            >
              历史分析（{reports.length}）
            </Link>
          ) : null}
        </div>
        <AnalysisReportPanel
          conversationId={conversationId}
          initialReports={reports.map((report) => ({
            ...report,
            createdAt: report.createdAt.toISOString(),
          }))}
          mode="create"
          role={workspace.role}
          workspaceId={workspaceId}
        />
      </main>
    );
  } catch {
    notFound();
  }
}
