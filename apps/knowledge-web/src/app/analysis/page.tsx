import { listKnowledgeWorkspaces } from "@culiu/knowledge-analysis";
import type { JSX } from "react";

import { AnalysisWorkspaceList } from "../../components/analysis-workspace-list";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";
import { getDatabaseClient } from "../../lib/database";

export default async function AnalysisPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const workspaces = (
    await listKnowledgeWorkspaces(getDatabaseClient().database, principal.id)
  ).map((workspace) => ({ ...workspace, updatedAt: workspace.updatedAt.toISOString() }));
  return (
    <main className="app-shell">
      <p className="eyebrow">内部知识分析</p>
      <h1>分析工作区</h1>
      <p className="page-lead">
        把讲座和匿名案例冻结到一个可复现的资料集合，并在其中创建彼此隔离的分析对话。
      </p>
      <AnalysisWorkspaceList workspaces={workspaces} />
    </main>
  );
}
