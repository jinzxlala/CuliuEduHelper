import {
  AuthorizationDeniedError,
  createStudentAuthorizationContext,
  readStudentOverview,
} from "@culiu/authorization";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../lib/database";

const privateHeaders = { "Cache-Control": "private, no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json({ error: "unauthorized" }, { headers: privateHeaders, status: 401 });
  }
  const studentId = z.uuid().safeParse((await params).studentId);
  if (!studentId.success) {
    return NextResponse.json({ error: "not_found" }, { headers: privateHeaders, status: 404 });
  }

  try {
    const database = getDatabaseClient().database;
    const context = await createStudentAuthorizationContext(database, principal, {
      action: "student:read",
      accessLevel: "sensitive",
      studentId: studentId.data,
    });
    const student = await readStudentOverview(database, context);
    return NextResponse.json({ student }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) {
      return NextResponse.json({ error: "not_found" }, { headers: privateHeaders, status: 404 });
    }
    throw error;
  }
}
