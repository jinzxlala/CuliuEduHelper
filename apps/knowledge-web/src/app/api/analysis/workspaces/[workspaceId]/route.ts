import {
  archiveKnowledgeWorkspace,
  readKnowledgeWorkspace,
  updateKnowledgeWorkspace,
} from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../lib/auth-session";
import { ANALYSIS_PRIVATE_HEADERS, analysisErrorResponse } from "../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../lib/database";

const PatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive") }).strict(),
  z
    .object({
      action: z.literal("update"),
      description: z.string().trim().max(2000).optional(),
      expectedUpdatedAt: z.iso.datetime({ offset: true }),
      name: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
]);

export async function GET(
  _request: Request,
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
      await readKnowledgeWorkspace(
        getDatabaseClient().database,
        principal.id,
        (await context.params).workspaceId,
      ),
      { headers: ANALYSIS_PRIVATE_HEADERS },
    );
  } catch (error) {
    return analysisErrorResponse(error);
  }
}

export async function PATCH(
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
    const workspaceId = (await context.params).workspaceId;
    const input = PatchSchema.parse(await request.json());
    if (input.action === "archive")
      await archiveKnowledgeWorkspace(getDatabaseClient().database, principal.id, workspaceId);
    else {
      await updateKnowledgeWorkspace(getDatabaseClient().database, principal.id, workspaceId, {
        description: input.description,
        expectedUpdatedAt: input.expectedUpdatedAt,
        name: input.name,
      });
    }
    return NextResponse.json({ status: "ok" }, { headers: ANALYSIS_PRIVATE_HEADERS });
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
