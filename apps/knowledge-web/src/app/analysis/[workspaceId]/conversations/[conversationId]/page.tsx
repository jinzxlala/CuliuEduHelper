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
import { AnalysisReportPanel } from "../../../../../components/analysis-report-panel";
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
    return (
      <main className="app-shell">
        <p className="eyebrow">
          <Link href={`/analysis/${workspaceId}`}>返回工作区</Link> · 当前对话独立上下文
        </p>
        <h1>{state.conversation.title}</h1>
        <p className="page-lead">
          本页只使用当前对话历史和工作区冻结资料，不会自动读取同一工作区的其他对话。
        </p>
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
        <AnalysisReportPanel
          conversationId={conversationId}
          initialReports={reports.map((report) => ({
            id: report.id,
            safeErrorSummary: report.safeErrorSummary,
            status: report.status,
            title: report.title,
            version: report.version,
          }))}
          role={workspace.role}
          workspaceId={workspaceId}
        />
      </main>
    );
  } catch {
    notFound();
  }
}
