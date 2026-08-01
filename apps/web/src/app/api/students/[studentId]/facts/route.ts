import { Buffer } from "node:buffer";

import { CreateStudentFactInputSchema, createStudentFact } from "@culiu/student-records";
import { NextResponse } from "next/server";

import { getDatabaseClient } from "../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../../lib/student-record-http";

const MAX_REQUEST_BYTES = 64 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const authorization = await createRouteStudentContext({
    accessLevel: "internal",
    action: "student:write",
    studentId: (await params).studentId,
  });
  if ("response" in authorization) return authorization.response;

  const bodyText = await request.text();
  if (Buffer.byteLength(bodyText, "utf8") > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { headers: privateStudentHeaders, status: 413 },
    );
  }
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      { headers: privateStudentHeaders, status: 400 },
    );
  }
  if (
    rawBody !== null &&
    typeof rawBody === "object" &&
    "validFrom" in rawBody &&
    typeof rawBody.validFrom === "string"
  ) {
    rawBody = { ...rawBody, validFrom: new Date(rawBody.validFrom) };
  }

  try {
    const input = CreateStudentFactInputSchema.parse(rawBody);
    const fact = await createStudentFact(
      getDatabaseClient().database,
      authorization.context,
      input,
    );
    return NextResponse.json({ fact }, { headers: privateStudentHeaders, status: 201 });
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
