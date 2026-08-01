import Link from "next/link";
import type { JSX } from "react";

import { SignOutButton } from "../../components/sign-out-button";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";
import { getDatabaseClient } from "../../lib/database";
import { createStudentDirectoryContext, listAuthorizedStudents } from "@culiu/authorization";

export const dynamic = "force-dynamic";

const privacyLabels = {
  internal: "内部",
  restricted: "严格受限",
  sensitive: "敏感",
} as const;

export default async function StudentsPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  const database = getDatabaseClient().database;
  const context = await createStudentDirectoryContext(database, principal);
  const students = await listAuthorizedStudents(database, context);

  return (
    <main className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/">
          醋溜教育智能助手
        </Link>
        <div className="account-actions">
          <span>{principal.displayName}</span>
          <SignOutButton />
        </div>
      </header>
      <section className="student-hero">
        <p className="eyebrow">Assigned students</p>
        <h1>已授权学生</h1>
        <p>这里只显示当前账号仍有读取权限、且授权等级足够的学生。</p>
      </section>
      {students.length === 0 ? (
        <section className="empty-state student-empty">
          <h2>暂无可访问学生</h2>
          <p>管理员身份不会自动获得学生资料；请由授权流程显式分配。</p>
        </section>
      ) : (
        <section className="student-grid" aria-label="已授权学生列表">
          {students.map((student) => (
            <article className="student-card" key={student.id}>
              <div>
                <span className="privacy-badge">{privacyLabels[student.privacyLevel]}</span>
                <h2>{student.publicCode}</h2>
              </div>
              <Link href={`/students/${student.id}`}>查看档案 →</Link>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
