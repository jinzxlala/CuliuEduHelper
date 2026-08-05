"use client";

import { signIn } from "next-auth/react";
import { useState, type JSX, type SyntheticEvent } from "react";

export function LoginForm({ callbackUrl }: Readonly<{ callbackUrl: string }>): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = form.get("email");
    const password = form.get("password");
    try {
      const result = await signIn("credentials", {
        callbackUrl,
        email: typeof email === "string" ? email : "",
        password: typeof password === "string" ? password : "",
        redirect: false,
      });
      if (result?.ok !== true) {
        setError("邮箱或密码不正确，或该账号已停用。");
        return;
      }
      window.location.assign(result.url ?? callbackUrl);
    } catch {
      setError("登录服务暂时不可用，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
      <label>
        <span>邮箱</span>
        <input autoComplete="username" name="email" required type="email" />
      </label>
      <label>
        <span>密码</span>
        <input autoComplete="current-password" name="password" required type="password" />
      </label>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? "正在验证…" : "登录"}
      </button>
    </form>
  );
}
