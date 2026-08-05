import {
  CourseCatalogAuthorizationError,
  CourseCatalogConflictError,
  CourseCatalogNotFoundError,
  CatalogTransitionInputSchema,
  CreateCourseInputSchema,
  ReviseCourseVersionInputSchema,
  createCourse,
  readCourseCatalogVersions,
  reviseCourseVersion,
  transitionCourseVersion,
} from "@culiu/course-planning";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_course"), input: CreateCourseInputSchema }).strict(),
  z
    .object({
      action: z.literal("revise_course"),
      courseVersionId: z.uuid(),
      input: ReviseCourseVersionInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("transition_course"),
      courseVersionId: z.uuid(),
      input: CatalogTransitionInputSchema,
    })
    .strict(),
]);

async function adminPrincipal(): Promise<Awaited<ReturnType<typeof getActiveSessionPrincipal>>> {
  const principal = await getActiveSessionPrincipal();
  return principal?.role === "admin" ? principal : null;
}

function courseCatalogError(error: unknown): NextResponse | null {
  if (
    error instanceof CourseCatalogAuthorizationError ||
    error instanceof CourseCatalogNotFoundError
  ) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  if (error instanceof CourseCatalogConflictError) {
    return NextResponse.json(
      {
        error: "conflict",
        message: "课程模板版本已发生变化，或当前状态不允许该操作，请刷新后重试。",
      },
      { headers: HEADERS, status: 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "invalid_input", message: "课程模板内容不完整或格式不正确。" },
      { headers: HEADERS, status: 422 },
    );
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const principal = await adminPrincipal();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  try {
    return NextResponse.json(
      { courses: await readCourseCatalogVersions(getDatabaseClient().database, principal) },
      { headers: HEADERS },
    );
  } catch (error) {
    const response = courseCatalogError(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await adminPrincipal();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { headers: HEADERS, status: 422 });
  }
  try {
    const database = getDatabaseClient().database;
    const result =
      parsed.data.action === "create_course"
        ? await createCourse(database, principal, parsed.data.input)
        : parsed.data.action === "revise_course"
          ? await reviseCourseVersion(
              database,
              principal,
              parsed.data.courseVersionId,
              parsed.data.input,
            )
          : await transitionCourseVersion(
              database,
              principal,
              parsed.data.courseVersionId,
              parsed.data.input,
            );
    return NextResponse.json(result, { headers: HEADERS, status: 201 });
  } catch (error) {
    const response = courseCatalogError(error);
    if (response !== null) return response;
    throw error;
  }
}
