import { readStudentRecord } from "@culiu/student-records";
import { NextResponse } from "next/server";

import { getDatabaseClient } from "../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../lib/student-record-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const authorization = await createRouteStudentContext({
    accessLevel: "internal",
    action: "student:read",
    studentId: (await params).studentId,
  });
  if ("response" in authorization) return authorization.response;

  try {
    const student = await readStudentRecord(getDatabaseClient().database, authorization.context);
    return NextResponse.json({ student }, { headers: privateStudentHeaders });
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
