import {
  MAX_EVIDENCE_BYTES,
  RegisterStudentEvidenceInputSchema,
  registerStudentEvidence,
} from "@culiu/student-records";
import { NextResponse } from "next/server";

import { getDatabaseClient } from "../../../../../lib/database";
import { getStudentObjectStore } from "../../../../../lib/object-store";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../../lib/student-record-http";

const MAX_MULTIPART_BYTES = MAX_EVIDENCE_BYTES + 128 * 1024;

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

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { headers: privateStudentHeaders, status: 413 },
    );
  }

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "file_required" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    const locatorsRaw = form.get("locators");
    if (typeof locatorsRaw !== "string") {
      return NextResponse.json(
        { error: "locators_required" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    let locators: unknown;
    try {
      locators = JSON.parse(locatorsRaw);
    } catch {
      return NextResponse.json(
        { error: "invalid_locators" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    const accessLevel = form.get("accessLevel");
    const supersedesEvidenceId = form.get("supersedesEvidenceId");
    const input = RegisterStudentEvidenceInputSchema.parse({
      accessLevel,
      content: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      locators,
      mimeType: file.type === "" ? "application/octet-stream" : file.type,
      ...(typeof supersedesEvidenceId === "string" && supersedesEvidenceId !== ""
        ? { supersedesEvidenceId }
        : {}),
    });
    const result = await registerStudentEvidence(
      getDatabaseClient().database,
      getStudentObjectStore(),
      authorization.context,
      input,
    );
    return NextResponse.json(result, { headers: privateStudentHeaders, status: 201 });
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
