import { createKnowledgeWorkspace, listKnowledgeWorkspaces } from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";

import { getActiveSessionPrincipal } from "../../../../lib/auth-session";
import { ANALYSIS_PRIVATE_HEADERS, analysisErrorResponse } from "../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../lib/database";

export async function GET(): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null)
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 401 },
    );
  return NextResponse.json(
    await listKnowledgeWorkspaces(getDatabaseClient().database, principal.id),
    { headers: ANALYSIS_PRIVATE_HEADERS },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
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
  try {
    return NextResponse.json(
      await createKnowledgeWorkspace(
        getDatabaseClient().database,
        principal.id,
        await request.json(),
      ),
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 201 },
    );
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
