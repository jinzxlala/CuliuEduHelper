import { redirect } from "next/navigation";
import type { JSX } from "react";

import { LoginForm } from "../../components/login-form";
import { getActiveSessionPrincipal } from "../../lib/auth-session";

export const dynamic = "force-dynamic";

function safeCallbackUrl(rawValue: string | string[] | undefined): string {
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/search";
}

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}>): Promise<JSX.Element> {
  if ((await getActiveSessionPrincipal()) !== null) {
    redirect("/search");
  }
  const callbackUrl = safeCallbackUrl((await searchParams).callbackUrl);
  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Internal access</p>
        <h1>知识系统登录</h1>
        <p>登录后可以搜索讲座与案例，并提交新的讲座资料。</p>
        <LoginForm callbackUrl={callbackUrl} />
        <p className="login-boundary">账号由管理员创建；系统不提供默认密码或公开注册。</p>
      </section>
    </main>
  );
}
