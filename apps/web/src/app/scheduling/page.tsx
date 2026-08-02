import { notFound } from "next/navigation";
import type { JSX } from "react";

import { SchedulingCatalog } from "../../components/scheduling-catalog";
import { requireActiveSessionPrincipal } from "../../lib/auth-session";

export const dynamic = "force-dynamic";

export default async function SchedulingPage(): Promise<JSX.Element> {
  const principal = await requireActiveSessionPrincipal();
  if (principal.role !== "admin") notFound();
  return (
    <main className="app-shell">
      <section className="student-hero">
        <p className="eyebrow">Course and scheduling catalog</p>
        <h1>课程、班级与排课配置</h1>
        <p>
          维护教师资质和可用时间、固定班级地点，以及每个班级的完整候选课表。文本学生名单不参与冲突检测。
        </p>
      </section>
      <SchedulingCatalog />
    </main>
  );
}
