import { createKnowledgeAnalysisAuthorizationContext } from "@culiu/authorization";
import {
  markKnowledgeAnalysisChatEnqueueFailure,
  prepareKnowledgeAnalysisMessage,
  readKnowledgeConversation,
} from "@culiu/knowledge-analysis";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../../../../lib/auth-session";
import {
  ANALYSIS_PRIVATE_HEADERS,
  analysisErrorResponse,
} from "../../../../../../../../lib/analysis-api";
import { getDatabaseClient } from "../../../../../../../../lib/database";
import { getTaskQueue } from "../../../../../../../../lib/task-queue";

const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
type RouteContext = { params: Promise<{ conversationId: string; workspaceId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null)
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 401 },
    );
  try {
    const params = await context.params;
    return NextResponse.json(
      await readKnowledgeConversation(
        getDatabaseClient().database,
        principal.id,
        params.workspaceId,
        params.conversationId,
      ),
      { headers: ANALYSIS_PRIVATE_HEADERS },
    );
  } catch (error) {
    return analysisErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
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
    const prepared = await prepareKnowledgeAnalysisMessage(
      database,
      authorization,
      params.workspaceId,
      params.conversationId,
      await request.json(),
      gitCommitSha.data,
    );
    try {
      await enqueueTask(getTaskQueue(), prepared.task);
    } catch {
      await markKnowledgeAnalysisChatEnqueueFailure(database, prepared.runId);
      return NextResponse.json(
        { error: "queue_unavailable" },
        { headers: ANALYSIS_PRIVATE_HEADERS, status: 503 },
      );
    }
    return NextResponse.json(
      { runId: prepared.runId, userMessageId: prepared.userMessageId },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 202 },
    );
  } catch (error) {
    return analysisErrorResponse(error);
  }
}
