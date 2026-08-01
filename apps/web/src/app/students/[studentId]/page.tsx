import {
  AuthorizationDeniedError,
  createStudentAuthorizationContext,
  readStudentOverview,
} from "@culiu/authorization";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { z } from "zod";

import { requireActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";

export const dynamic = "force-dynamic";

export default async function StudentDetailPage({
  params,
}: Readonly<{ params: Promise<{ studentId: string }> }>): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const studentId = z.uuid().safeParse((await params).studentId);
  if (!studentId.success) notFound();

  const database = getDatabaseClient().database;
  let student;
  try {
    const context = await createStudentAuthorizationContext(database, principal, {
      action: "student:read",
      accessLevel: "sensitive",
      studentId: studentId.data,
    });
    student = await readStudentOverview(database, context);
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) notFound();
    throw error;
  }

  return (
    <main className="detail-shell">
      <header className="detail-nav">
        <Link href="/students">← 返回已授权学生</Link>
        <span>学生档案 · 受保护</span>
      </header>
      <article className="detail-card">
        <p className="eyebrow">Student profile</p>
        <h1>{student.publicCode}</h1>
        <div className="boundary-card">
          <h2>数据边界</h2>
          <p>本页仅展示当前学生域内的脱敏事实；知识库案例不会被写成学生事实。</p>
        </div>
        <section className="detail-section">
          <h2>已记录事实</h2>
          {student.facts.length === 0 ? (
            <p>暂无已记录事实。</p>
          ) : (
            <dl className="fact-list">
              {student.facts.map((fact) => (
                <div key={fact.id}>
                  <dt>{fact.fieldKey}</dt>
                  <dd>{JSON.stringify(fact.value)}</dd>
                  <small>
                    {fact.sourceType} · {fact.confirmationStatus}
                  </small>
                </div>
              ))}
            </dl>
          )}
        </section>
      </article>
    </main>
  );
}
