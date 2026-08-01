import {
  ProfileRevisionInputSchema,
  ProfileWorkflowConflictError,
  ProfileWorkflowNotFoundError,
  reviseProfileVersion,
} from "@culiu/student-profiles";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabaseClient } from "../../../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../../../../lib/student-record-http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profileId: string; studentId: string }> },
): Promise<NextResponse> {
  const routeParams = await params;
  const authorization = await createRouteStudentContext({
    accessLevel: "sensitive",
    action: "student:profile:review",
    studentId: routeParams.studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const input = ProfileRevisionInputSchema.parse(await request.json());
    const result = await reviseProfileVersion(
      getDatabaseClient().database,
      authorization.context,
      routeParams.profileId,
      input,
    );
    return NextResponse.json(result, { headers: privateStudentHeaders, status: 201 });
  } catch (error) {
    if (error instanceof ProfileWorkflowNotFoundError) {
      return NextResponse.json(
        { error: "not_found" },
        { headers: privateStudentHeaders, status: 404 },
      );
    }
    if (error instanceof ProfileWorkflowConflictError) {
      return NextResponse.json(
        { error: "conflict", message: error.message },
        { headers: privateStudentHeaders, status: 409 },
      );
    }
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_request" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    throw error;
  }
}
