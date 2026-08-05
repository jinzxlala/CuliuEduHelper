import { readKnowledgeAnalysisReportArtifact } from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../../../lib/database";
import { getKnowledgeObjectStore } from "../../../../../../../../lib/object-store";

const QuerySchema = z
  .object({ download: z.enum(["0", "1"]).default("0"), variant: z.enum(["interactive", "static"]) })
  .strict();

export async function GET(
  request: Request,
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
    const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const content = await readKnowledgeAnalysisReportArtifact(
      getDatabaseClient().database,
      getKnowledgeObjectStore(),
      principal.id,
      params.workspaceId,
      params.reportId,
      query.variant,
    );
    const disposition =
      query.download === "1"
        ? `attachment; filename="analysis-report-${params.reportId}-${query.variant}.html"`
        : "inline";
    return new NextResponse(Uint8Array.from(content), {
      headers: {
        ...ANALYSIS_PRIVATE_HEADERS,
        "Content-Disposition": disposition,
        "Content-Security-Policy":
          query.variant === "interactive" ? "sandbox allow-scripts" : "sandbox",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
