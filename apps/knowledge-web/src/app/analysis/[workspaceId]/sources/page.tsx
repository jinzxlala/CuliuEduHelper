import { readKnowledgeWorkspace } from "@culiu/knowledge-analysis";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AnalysisSourcePicker } from "../../../../components/analysis-source-picker";
import { requireActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../lib/database";

export default async function WorkspaceSourcesPage({
  params,
}: Readonly<{ params: Promise<{ workspaceId: string }> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const { workspaceId } = await params;
  try {
    const detail = await readKnowledgeWorkspace(
      getDatabaseClient().database,
      principal.id,
      workspaceId,
    );
    if (detail.workspace.status !== "active" || detail.role === "viewer") notFound();
    return (
      <main className="app-shell">
        <AnalysisSourcePicker workspaceId={workspaceId} workspaceName={detail.workspace.name} />
      </main>
    );
  } catch {
    notFound();
  }
}
