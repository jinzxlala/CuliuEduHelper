import { AuthorizationDeniedError, createStudentAuthorizationContext } from "@culiu/authorization";
import {
  PlanWorkflowNotFoundError,
  readCourseRecommendations,
  readManualPlanningWorkspace,
} from "@culiu/course-planning";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { z } from "zod";

import { CoursePlanningPanel } from "../../../../components/course-planning-panel";
import { requireActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../lib/database";

export const dynamic = "force-dynamic";

export default async function StudentPlanningPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ recommendation?: string }>;
}>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const studentId = z.uuid().safeParse((await params).studentId);
  if (!studentId.success) notFound();
  const database = getDatabaseClient().database;
  try {
    const context = await createStudentAuthorizationContext(database, principal, {
      accessLevel: "sensitive",
      action: "student:read",
      studentId: studentId.data,
    });
    const workspace = await readManualPlanningWorkspace(database, context);
    const recommendationId = z.uuid().safeParse((await searchParams).recommendation);
    let recommendedCourseVersionIds: string[] = [];
    if (recommendationId.success) {
      const recommendationContext = await createStudentAuthorizationContext(database, principal, {
        accessLevel: "sensitive",
        action: "student:recommendation:review",
        studentId: studentId.data,
      });
      const recommendation = (
        await readCourseRecommendations(database, recommendationContext)
      ).find((item) => item.id === recommendationId.data && item.status === "accepted");
      recommendedCourseVersionIds =
        recommendation?.output.recommendations.map((item) => item.courseVersionId) ?? [];
    }
    return (
      <main className="detail-shell student-record-shell">
        <header className="detail-nav">
          <Link href={`/students/${studentId.data}`}>← 返回学生档案</Link>
          <span>课程规划 · 受保护</span>
        </header>
        <article className="detail-card">
          <p className="eyebrow">Student course plan</p>
          <h1>课程规划</h1>
          <CoursePlanningPanel
            initialData={workspace}
            recommendedCourseVersionIds={recommendedCourseVersionIds}
            studentId={studentId.data}
          />
        </article>
      </main>
    );
  } catch (error) {
    if (error instanceof AuthorizationDeniedError || error instanceof PlanWorkflowNotFoundError) {
      notFound();
    }
    throw error;
  }
}
