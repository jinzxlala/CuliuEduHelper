import {
  buildKnowledgeSubmission,
  KnowledgeImportError,
  KnowledgeSourceError,
  MAX_KNOWLEDGE_SUBMISSION_BYTES,
  type SubmittedKnowledgeFile,
} from "@culiu/knowledge-ingest";
import { NextResponse } from "next/server";

import { getActiveSessionPrincipal } from "../../../../lib/auth-session";
import { publishKnowledgeSubmission } from "../../../../lib/knowledge-import";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

async function submittedFile(
  form: FormData,
  name: string,
): Promise<SubmittedKnowledgeFile | undefined> {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) return undefined;
  return { bytes: new Uint8Array(await value.arrayBuffer()), fileName: value.name };
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: PRIVATE_HEADERS, status: 401 },
    );
  }
  if (principal.role !== "admin") {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_KNOWLEDGE_SUBMISSION_BYTES + 256 * 1024
  ) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { headers: PRIVATE_HEADERS, status: 413 },
    );
  }
  try {
    const form = await request.formData();
    const mode = form.get("mode");
    if (mode !== "analysis" && mode !== "evidence") {
      return NextResponse.json(
        { error: "invalid_mode" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    const analysis = await submittedFile(form, "analysis");
    if (analysis === undefined) {
      return NextResponse.json(
        { error: "analysis_required" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    const loaded =
      mode === "analysis"
        ? buildKnowledgeSubmission({ analysis })
        : await (async () => {
            const transcriptJson = await submittedFile(form, "transcriptJson");
            const transcriptQa = await submittedFile(form, "transcriptQa");
            const transcriptSrt = await submittedFile(form, "transcriptSrt");
            const transcriptText = await submittedFile(form, "transcriptText");
            if (
              transcriptJson === undefined ||
              transcriptQa === undefined ||
              transcriptSrt === undefined ||
              transcriptText === undefined
            ) {
              throw new KnowledgeSourceError(
                "missing_source",
                "完整证据包需要分析稿、JSON、QA JSON、SRT 和时间戳 TXT。",
              );
            }
            return buildKnowledgeSubmission({
              analysis,
              transcriptJson,
              transcriptQa,
              transcriptSrt,
              transcriptText,
            });
          })();
    const result = await publishKnowledgeSubmission(principal.id, loaded);
    return NextResponse.json(result, {
      headers: PRIVATE_HEADERS,
      status: result.status === "published" ? 201 : 200,
    });
  } catch (error) {
    if (error instanceof KnowledgeSourceError || error instanceof KnowledgeImportError) {
      return NextResponse.json(
        {
          error: error instanceof KnowledgeSourceError ? error.code : error.code,
          message: error.message,
        },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    throw error;
  }
}
