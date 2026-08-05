import { redirect } from "next/navigation";
import type { JSX } from "react";

import { LoginForm } from "../../components/login-form";
import { getActiveSessionPrincipal } from "../../lib/auth-session";

export const dynamic = "force-dynamic";

function safeCallbackUrl(rawValue: string | string[] | undefined): string {
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/students";
}

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}>): Promise<JSX.Element> {
  if ((await getActiveSessionPrincipal()) !== null) {
    redirect("/students");
  }
  const callbackUrl = safeCallbackUrl((await searchParams).callbackUrl);
  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Internal access</p>
        <h1>教务系统登录</h1>
        <p>登录后才能访问已获授权的学生档案、课程规划与排课功能。</p>
        <LoginForm callbackUrl={callbackUrl} />
        <p className="login-boundary">账号由管理员创建；系统不提供默认密码或公开注册。</p>
      </section>
    </main>
  );
}
