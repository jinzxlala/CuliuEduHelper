import { readKnowledgeWorkspace } from "@culiu/knowledge-analysis";
import Link from "next/link";
import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import type { JSX } from "react";

import { AnalysisWorkspaceDetail } from "../../../components/analysis-workspace-detail";
import { requireActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";

export default async function WorkspacePage({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const { workspaceId } = await params;
  let detail: Awaited<ReturnType<typeof readKnowledgeWorkspace>>;
  try {
    const database = getDatabaseClient().database;
    detail = await readKnowledgeWorkspace(database, principal.id, workspaceId);
  } catch {
    notFound();
  }
  const latestConversation = detail.conversations.find((item) => item.status === "active");
  if (detail.workspace.status === "active" && latestConversation !== undefined)
    redirect(`/analysis/${workspaceId}/conversations/${latestConversation.id}`);
  return (
    <main className="app-shell">
      <p className="eyebrow">
        <Link href="/analysis">分析工作区</Link> · {detail.role}
      </p>
      <h1>{detail.workspace.name}</h1>
      <p className="page-lead">{detail.workspace.description || "尚未填写说明。"}</p>
      <AnalysisWorkspaceDetail
        role={detail.role}
        sources={detail.sources.map((item) => ({
          contentHash: item.contentHash,
          id: item.id,
          removedAt: item.removedAt?.toISOString() ?? null,
          sourceId: item.sourceId,
          sourceType: item.sourceType,
        }))}
        status={detail.workspace.status}
        workspaceId={workspaceId}
      />
    </main>
  );
}
