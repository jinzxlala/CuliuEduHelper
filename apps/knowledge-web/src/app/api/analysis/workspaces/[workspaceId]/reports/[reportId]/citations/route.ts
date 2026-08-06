import { readKnowledgeAnalysisReportCitationAudit } from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";

import { getActiveSessionPrincipal } from "../../../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../../../lib/database";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reportId: string; workspaceId: string }> },
): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null)
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 401 },
    );
  try {
    const params = await context.params;
    return NextResponse.json(
      await readKnowledgeAnalysisReportCitationAudit(
        getDatabaseClient().database,
        principal.id,
        params.workspaceId,
        params.reportId,
      ),
      { headers: ANALYSIS_PRIVATE_HEADERS },
    );
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
