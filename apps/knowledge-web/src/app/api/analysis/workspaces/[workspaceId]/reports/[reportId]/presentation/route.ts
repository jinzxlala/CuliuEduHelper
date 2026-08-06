import { createKnowledgeAnalysisAuthorizationContext } from "@culiu/authorization";
import { rerenderKnowledgeAnalysisReportPresentation } from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../../../lib/database";
import { getKnowledgeObjectStore } from "../../../../../../../../lib/object-store";

const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export async function POST(
  _request: Request,
  context: { params: Promise<{ reportId: string; workspaceId: string }> },
): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null)
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 401 },
    );
  if (principal.role === "auditor")
    return NextResponse.json(
      { error: "not_found" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 404 },
    );
  const gitCommitSha = GitCommitShaSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
  if (!gitCommitSha.success)
    return NextResponse.json(
      { error: "server_not_configured" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 503 },
    );
  try {
    const params = await context.params;
    const database = getDatabaseClient().database;
    const authorization = await createKnowledgeAnalysisAuthorizationContext(database, principal);
    const created = await rerenderKnowledgeAnalysisReportPresentation(
      database,
      getKnowledgeObjectStore(),
      authorization,
      params.workspaceId,
      params.reportId,
      gitCommitSha.data,
    );
    return NextResponse.json(created, { headers: ANALYSIS_PRIVATE_HEADERS, status: 201 });
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
