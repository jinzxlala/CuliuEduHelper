import {
  AuthorizationDeniedError,
  createStudentAuthorizationContext,
  type AccessLevel,
  type AuthorizationContext,
  type SessionPrincipal,
  type StudentAction,
} from "@culiu/authorization";
import { StudentRecordConflictError, StudentRecordNotFoundError } from "@culiu/student-records";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "./auth-session";
import { getDatabaseClient } from "./database";

export const privateStudentHeaders = { "Cache-Control": "private, no-store" } as const;

export async function createRouteStudentContext(input: {
  accessLevel: AccessLevel;
  action: StudentAction;
  studentId: string;
}): Promise<
  { context: AuthorizationContext; principal: SessionPrincipal } | { response: NextResponse }
> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return {
      response: NextResponse.json(
        { error: "unauthorized" },
        { headers: privateStudentHeaders, status: 401 },
      ),
    };
  }
  const studentId = z.uuid().safeParse(input.studentId);
  if (!studentId.success) {
    return {
      response: NextResponse.json(
        { error: "not_found" },
        { headers: privateStudentHeaders, status: 404 },
      ),
    };
  }
  try {
    const context = await createStudentAuthorizationContext(
      getDatabaseClient().database,
      principal,
      { ...input, studentId: studentId.data },
    );
    return { context, principal };
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return { response };
    throw error;
  }
}

export function studentRecordErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AuthorizationDeniedError || error instanceof StudentRecordNotFoundError) {
    return NextResponse.json(
      { error: "not_found" },
      { headers: privateStudentHeaders, status: 404 },
    );
  }
  if (error instanceof StudentRecordConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { headers: privateStudentHeaders, status: 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "invalid_request" },
      { headers: privateStudentHeaders, status: 422 },
    );
  }
  return null;
}
