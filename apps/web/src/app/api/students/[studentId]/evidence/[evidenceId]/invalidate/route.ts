import { invalidateStudentEvidence } from "@culiu/student-records";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabaseClient } from "../../../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../../../../lib/student-record-http";

const InvalidationRequestSchema = z.object({ reason: z.string().trim().min(1).max(512) }).strict();

export async function POST(
  request: Request,
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
    action: "student:write",
    studentId: routeParams.studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const input = InvalidationRequestSchema.parse(await request.json());
    await invalidateStudentEvidence(getDatabaseClient().database, authorization.context, {
      evidenceObjectId: evidenceId.data,
      reason: input.reason,
    });
    return NextResponse.json({ invalidated: true }, { headers: privateStudentHeaders });
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_json" },
        { headers: privateStudentHeaders, status: 400 },
      );
    }
    throw error;
  }
}
