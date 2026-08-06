import {
  listKnowledgeWorkspaceShareCandidates,
  readKnowledgeWorkspace,
} from "@culiu/knowledge-analysis";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AnalysisSharingManager } from "../../../../components/analysis-sharing-manager";
import { requireActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../lib/database";

export default async function WorkspaceSharingPage({
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
    const latest = detail.conversations.find((item) => item.status === "active");
    return (
      <main className="app-shell narrow-shell">
        <p className="eyebrow">工作区设置</p>
        <h1>管理共享</h1>
        <p className="page-lead">{detail.workspace.name}</p>
        <div className="page-action-row">
          <Link
            className="secondary-button button-link"
            href={
              latest === undefined
                ? `/analysis/${workspaceId}`
                : `/analysis/${workspaceId}/conversations/${latest.id}`
            }
          >
            返回工作区
          </Link>
          <Link className="secondary-button button-link" href="/analysis">
            所有工作区
          </Link>
        </div>
        <AnalysisSharingManager
          candidates={candidates}
          members={detail.members}
          role={detail.role}
          status={detail.workspace.status}
          workspaceId={workspaceId}
        />
      </main>
    );
  } catch {
    notFound();
  }
}
