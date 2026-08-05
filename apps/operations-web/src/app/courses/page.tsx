import { notFound } from "next/navigation";
import type { JSX } from "react";

import { CourseCatalogManager } from "../../components/course-catalog-manager";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";

export const dynamic = "force-dynamic";

export default async function CoursesPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  if (principal.role !== "admin") notFound();
  return (
    <main className="app-shell">
      <section className="student-hero">
        <p className="eyebrow">Course template catalog</p>
        <h1>课程模板管理</h1>
        <p>
          维护课程内容、适用阶段、课时、能力标签和固定周课时段。只有人工批准的版本才能用于班级和排课。
        </p>
      </section>
      <CourseCatalogManager />
    </main>
  );
}
