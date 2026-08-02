import {
  CreateManualPlanInputSchema,
  createManualPlanVersion,
  readManualPlanningWorkspace,
} from "@culiu/course-planning";
import { NextResponse } from "next/server";

import { coursePlanningErrorResponse } from "../../../../../lib/course-planning-http";
import { getDatabaseClient } from "../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
} from "../../../../../lib/student-record-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const authorization = await createRouteStudentContext({
    accessLevel: "sensitive",
    action: "student:read",
    studentId: (await params).studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const workspace = await readManualPlanningWorkspace(
      getDatabaseClient().database,
      authorization.context,
    );
    return NextResponse.json(workspace, { headers: privateStudentHeaders });
  } catch (error) {
    const response = coursePlanningErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  try {
    const input = CreateManualPlanInputSchema.parse(await request.json());
    const authorization = await createRouteStudentContext({
      accessLevel: "sensitive",
      action: "student:plan:write",
      studentId: (await params).studentId,
    });
    if ("response" in authorization) return authorization.response;
    const plan = await createManualPlanVersion(
      getDatabaseClient().database,
      authorization.context,
      input,
    );
    return NextResponse.json({ plan }, { headers: privateStudentHeaders, status: 201 });
  } catch (error) {
    const response = coursePlanningErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
