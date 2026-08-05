"use client";

import { signOut } from "next-auth/react";
import type { JSX } from "react";

export function SignOutButton(): JSX.Element {
  return (
    <button
      className="text-button"
      onClick={() => void signOut({ callbackUrl: "/login" })}
      type="button"
    >
      退出登录
    </button>
  );
}
