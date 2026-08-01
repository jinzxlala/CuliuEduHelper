import {
  ProfileTransitionInputSchema,
  ProfileWorkflowConflictError,
  ProfileWorkflowNotFoundError,
  transitionProfileVersion,
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
  let input: z.infer<typeof ProfileTransitionInputSchema>;
  try {
    input = ProfileTransitionInputSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_request" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    throw error;
  }
  const authorization = await createRouteStudentContext({
    accessLevel: "sensitive",
    action:
      input.action === "approve" || input.action === "archive"
        ? "student:profile:approve"
        : "student:profile:review",
    studentId: routeParams.studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const result = await transitionProfileVersion(
      getDatabaseClient().database,
      authorization.context,
      routeParams.profileId,
      input,
    );
    return NextResponse.json(result, { headers: privateStudentHeaders });
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
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_request" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    throw error;
  }
}
