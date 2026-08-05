import { createKnowledgeConversation } from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";

import { getActiveSessionPrincipal } from "../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../lib/database";

export async function POST(
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
    return NextResponse.json(
      await createKnowledgeConversation(
        getDatabaseClient().database,
        principal.id,
        (await context.params).workspaceId,
        await request.json(),
      ),
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 201 },
    );
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
