import {
  addKnowledgeWorkspaceSources,
  listKnowledgeWorkspaceSourceUpdates,
  removeKnowledgeWorkspaceSource,
  resolveCurrentKnowledgeSourceReference,
  updateKnowledgeWorkspaceSourceVersion,
} from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../lib/database";

const AddSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().trim().min(1).max(511),
            sourceType: z.enum(["lecture", "case"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const UpdateSchema = z.object({ sourceRecordId: z.uuid() }).strict();

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
    const input = AddSchema.parse(await request.json());
    const database = getDatabaseClient().database;
    const references = await Promise.all(
      input.sources.map((source) =>
        resolveCurrentKnowledgeSourceReference(database, source.sourceType, source.sourceId),
      ),
    );
    return NextResponse.json(
      await addKnowledgeWorkspaceSources(
        database,
        principal.id,
        (await context.params).workspaceId,
        { sources: references },
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
    const input = UpdateSchema.parse(await request.json());
    const workspaceId = (await context.params).workspaceId;
    const updates = await listKnowledgeWorkspaceSourceUpdates(
      getDatabaseClient().database,
      principal.id,
      workspaceId,
    );
    const update = updates.find((item) => item.currentSourceId === input.sourceRecordId);
    if (update === undefined)
      return NextResponse.json(
        { error: "not_found" },
        { headers: ANALYSIS_PRIVATE_HEADERS, status: 404 },
      );
    return NextResponse.json(
      await updateKnowledgeWorkspaceSourceVersion(
        getDatabaseClient().database,
        principal.id,
        workspaceId,
        input.sourceRecordId,
        update.latest,
      ),
      { headers: ANALYSIS_PRIVATE_HEADERS },
    );
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
    await removeKnowledgeWorkspaceSource(
      getDatabaseClient().database,
      principal.id,
      (await context.params).workspaceId,
      new URL(request.url).searchParams.get("sourceRecordId") ?? "",
    );
    return NextResponse.json({ status: "ok" }, { headers: ANALYSIS_PRIVATE_HEADERS });
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
