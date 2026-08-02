import { notFound } from "next/navigation";
import type { JSX } from "react";

import { StudentImportForm } from "../../../components/student-import-form";
import { requireActiveSessionPrincipal } from "../../../lib/auth-session";

export const dynamic = "force-dynamic";

export default async function StudentImportPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  if (principal.role !== "admin") notFound();
  return (
    <main className="app-shell">
      <section className="student-hero">
        <p className="eyebrow">Restricted student onboarding</p>
        <h1>批量导入学生基础信息</h1>
        <p>系统先生成候选学生和逐字段建议；只有你确认的字段才会进入正式学生档案。</p>
      </section>
      <StudentImportForm />
    </main>
  );
}
