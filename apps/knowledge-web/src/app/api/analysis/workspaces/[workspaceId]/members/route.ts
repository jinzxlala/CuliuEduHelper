import {
  revokeKnowledgeWorkspaceMember,
  setKnowledgeWorkspaceMember,
} from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";

import { getActiveSessionPrincipal } from "../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../lib/database";

export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null)
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 401 },
    );
  try {
    await setKnowledgeWorkspaceMember(
      getDatabaseClient().database,
      principal.id,
      (await context.params).workspaceId,
      await request.json(),
    );
    return NextResponse.json({ status: "ok" }, { headers: ANALYSIS_PRIVATE_HEADERS });
  } catch (error) {
    return analysisErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null)
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 401 },
    );
  try {
    const userId = new URL(request.url).searchParams.get("userId") ?? "";
    await revokeKnowledgeWorkspaceMember(
      getDatabaseClient().database,
      principal.id,
      (await context.params).workspaceId,
      userId,
    );
    return NextResponse.json({ status: "ok" }, { headers: ANALYSIS_PRIVATE_HEADERS });
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
