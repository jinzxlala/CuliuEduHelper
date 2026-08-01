import { readStudentEvidenceContent } from "@culiu/student-records";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabaseClient } from "../../../../../../lib/database";
import { getStudentObjectStore } from "../../../../../../lib/object-store";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../../../lib/student-record-http";

function contentDisposition(fileName: string): string {
  return `attachment; filename="evidence"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ evidenceId: string; studentId: string }> },
): Promise<NextResponse> {
  const routeParams = await params;
  const evidenceId = z.uuid().safeParse(routeParams.evidenceId);
  if (!evidenceId.success) {
    return NextResponse.json(
      { error: "not_found" },
      { headers: privateStudentHeaders, status: 404 },
    );
  }
  const authorization = await createRouteStudentContext({
    accessLevel: "internal",
    action: "student:read",
    studentId: routeParams.studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const evidence = await readStudentEvidenceContent(
      getDatabaseClient().database,
      getStudentObjectStore(),
      authorization.context,
      evidenceId.data,
    );
    const responseBytes = new Uint8Array(evidence.content.byteLength);
    responseBytes.set(evidence.content);
    return new NextResponse(responseBytes.buffer, {
      headers: {
        ...privateStudentHeaders,
        "Content-Disposition": contentDisposition(evidence.originalFileName),
        "Content-Type": evidence.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
