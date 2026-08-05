import {
  listKnowledgeWorkspaceShareCandidates,
  readKnowledgeWorkspace,
} from "@culiu/knowledge-analysis";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AnalysisWorkspaceDetail } from "../../../components/analysis-workspace-detail";
import { requireActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";

export default async function WorkspacePage({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const { workspaceId } = await params;
  try {
    const database = getDatabaseClient().database;
    const detail = await readKnowledgeWorkspace(database, principal.id, workspaceId);
    const candidates =
      detail.role === "owner" && detail.workspace.status === "active"
        ? await listKnowledgeWorkspaceShareCandidates(database, principal.id, workspaceId)
        : [];
    return (
      <main className="app-shell">
        <p className="eyebrow">分析工作区 · {detail.role}</p>
        <h1>{detail.workspace.name}</h1>
        <p className="page-lead">{detail.workspace.description || "尚未填写说明。"}</p>
        <AnalysisWorkspaceDetail
          candidates={candidates}
          conversations={detail.conversations.map((item) => ({
            ...item,
            updatedAt: item.updatedAt.toISOString(),
          }))}
          members={detail.members}
          role={detail.role}
          sources={detail.sources.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
            removedAt: item.removedAt?.toISOString() ?? null,
          }))}
          status={detail.workspace.status}
          workspaceId={workspaceId}
        />
      </main>
    );
  } catch {
    notFound();
  }
}
