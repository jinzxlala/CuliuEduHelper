import {
  PlanRuleOverrideNotFoundError,
  PlanWorkflowConflictError,
  PlanWorkflowNotFoundError,
} from "@culiu/course-planning";
import { NextResponse } from "next/server";
import { z } from "zod";

import { privateStudentHeaders, studentRecordErrorResponse } from "./student-record-http";

export function coursePlanningErrorResponse(error: unknown): NextResponse | null {
  if (
    error instanceof PlanWorkflowNotFoundError ||
    error instanceof PlanRuleOverrideNotFoundError
  ) {
    return NextResponse.json(
      { error: "not_found" },
      { headers: privateStudentHeaders, status: 404 },
    );
  }
  if (error instanceof PlanWorkflowConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { headers: privateStudentHeaders, status: 409 },
    );
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_request" },
      { headers: privateStudentHeaders, status: 422 },
    );
  }
  return studentRecordErrorResponse(error);
}
