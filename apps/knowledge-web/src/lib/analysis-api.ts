import {
  KnowledgeWorkspaceConflictError,
  KnowledgeWorkspaceNotFoundError,
} from "@culiu/knowledge-analysis";
import { NextResponse } from "next/server";
import { z } from "zod";

export const ANALYSIS_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

export function analysisErrorResponse(error: unknown): NextResponse {
  if (error instanceof KnowledgeWorkspaceNotFoundError) {
    return NextResponse.json(
      { error: "not_found" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 404 },
    );
  }
  if (error instanceof KnowledgeWorkspaceConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "invalid_input" },
      { headers: ANALYSIS_PRIVATE_HEADERS, status: 422 },
    );
  }
  throw error;
}
