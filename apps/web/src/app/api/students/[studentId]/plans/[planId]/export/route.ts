import { exportApprovedManualPlanMarkdown } from "@culiu/course-planning";
import { NextResponse } from "next/server";

import { coursePlanningErrorResponse } from "../../../../../../../lib/course-planning-http";
import { getDatabaseClient } from "../../../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
} from "../../../../../../../lib/student-record-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ planId: string; studentId: string }> },
): Promise<NextResponse> {
  const routeParams = await params;
  const authorization = await createRouteStudentContext({
    accessLevel: "sensitive",
    action: "student:plan:export",
    studentId: routeParams.studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const markdown = await exportApprovedManualPlanMarkdown(
      getDatabaseClient().database,
      authorization.context,
      routeParams.planId,
    );
    return new NextResponse(markdown, {
      headers: {
        ...privateStudentHeaders,
        "Content-Disposition": `attachment; filename="course-plan-${routeParams.planId}.md"`,
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const response = coursePlanningErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
