import { createKnowledgeAnalysisAuthorizationContext } from "@culiu/authorization";
import {
  markKnowledgeSmartSearchEnqueueFailure,
  listKnowledgeSmartSearches,
  prepareKnowledgeSmartSearch,
  readKnowledgeSmartSearch,
} from "@culiu/knowledge-analysis";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";
import { getTaskQueue } from "../../../lib/task-queue";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const RunIdSchema = z.uuid();
const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: PRIVATE_HEADERS, status: 401 },
    );
  }
  const rawRunId = new URL(request.url).searchParams.get("id");
  const runId = RunIdSchema.safeParse(rawRunId);
  try {
    if (rawRunId === null) {
      return NextResponse.json(
        await listKnowledgeSmartSearches(getDatabaseClient().database, principal.id),
        { headers: PRIVATE_HEADERS },
      );
    }
    if (!runId.success)
      return NextResponse.json(
        { error: "invalid_run_id" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    return NextResponse.json(
      await readKnowledgeSmartSearch(getDatabaseClient().database, principal.id, runId.data),
      { headers: PRIVATE_HEADERS },
    );
  } catch {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: PRIVATE_HEADERS, status: 401 },
    );
  }
  if (principal.role === "auditor") {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const gitCommitSha = GitCommitShaSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
  if (!gitCommitSha.success) {
    return NextResponse.json(
      { error: "server_not_configured", message: "服务端缺少有效的提交版本配置。" },
      { headers: PRIVATE_HEADERS, status: 503 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { headers: PRIVATE_HEADERS, status: 422 });
  }
  try {
    const database = getDatabaseClient().database;
    const authorization = await createKnowledgeAnalysisAuthorizationContext(database, principal);
    const prepared = await prepareKnowledgeSmartSearch(
      database,
      authorization,
      body,
      gitCommitSha.data,
    );
    try {
      await enqueueTask(getTaskQueue(), prepared.task);
    } catch {
      await markKnowledgeSmartSearchEnqueueFailure(database, prepared.runId);
      return NextResponse.json(
        { error: "queue_unavailable", message: "智能搜索任务暂时无法进入队列。" },
        { headers: PRIVATE_HEADERS, status: 503 },
      );
    }
    return NextResponse.json(
      { runId: prepared.runId, status: "queued" },
      { headers: PRIVATE_HEADERS, status: 202 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_input" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    return NextResponse.json(
      {
        error: "smart_search_unavailable",
        message: "暂时无法创建智能搜索，请使用普通关键词搜索。",
      },
      { headers: PRIVATE_HEADERS, status: 503 },
    );
  }
}
