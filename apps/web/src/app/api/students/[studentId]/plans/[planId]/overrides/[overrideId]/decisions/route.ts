import { DecidePlanRuleOverrideInputSchema, decidePlanRuleOverride } from "@culiu/course-planning";
import { NextResponse } from "next/server";

import { coursePlanningErrorResponse } from "../../../../../../../../../lib/course-planning-http";
import { getDatabaseClient } from "../../../../../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
} from "../../../../../../../../../lib/student-record-http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ overrideId: string; planId: string; studentId: string }> },
): Promise<NextResponse> {
  try {
    const input = DecidePlanRuleOverrideInputSchema.parse(await request.json());
    const routeParams = await params;
    const authorization = await createRouteStudentContext({
      accessLevel: "sensitive",
      action: "student:plan:approve",
      studentId: routeParams.studentId,
    });
    if ("response" in authorization) return authorization.response;
    const result = await decidePlanRuleOverride(
      getDatabaseClient().database,
      authorization.context,
      routeParams.overrideId,
      input,
    );
    return NextResponse.json(result, { headers: privateStudentHeaders });
  } catch (error) {
    const response = coursePlanningErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
