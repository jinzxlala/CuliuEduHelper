import { randomUUID } from "node:crypto";

import { InteractiveUserRoleSchema, type SessionPrincipal } from "@culiu/authorization";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export interface AuthOptionDependencies {
  authenticate: (
    credentials: { email: string; password: string },
    requestCorrelationId: string,
  ) => Promise<SessionPrincipal | null>;
}

export function createAuthOptions(
  dependencies: AuthOptionDependencies,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NextAuthOptions {
  const baseUrl = environment.NEXTAUTH_URL;
  const useSecureCookies =
    baseUrl === undefined ? environment.NODE_ENV === "production" : baseUrl.startsWith("https://");
  const secret = environment.NEXTAUTH_SECRET;
  if (secret !== undefined && Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("NEXTAUTH_SECRET must contain at least 32 bytes.");
  }
  const configuredCookieName = environment.CULIU_AUTH_COOKIE_NAME?.trim();
  const sessionCookieName =
    configuredCookieName === undefined || configuredCookieName === ""
      ? useSecureCookies
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token"
      : useSecureCookies
        ? `__Secure-${configuredCookieName.replace(/^__Secure-/u, "")}`
        : configuredCookieName.replace(/^__Secure-/u, "");
  return {
    callbacks: {
      jwt: ({ token, trigger, user }) => {
        if (trigger === "signIn") {
          token.sub = user.id;
          token.role = user.role;
        }
        return token;
      },
      redirect: ({ baseUrl: trustedBaseUrl, url }) => {
        if (url.startsWith("/")) return `${trustedBaseUrl}${url}`;
        try {
          return new URL(url).origin === trustedBaseUrl ? url : trustedBaseUrl;
        } catch {
          return trustedBaseUrl;
        }
      },
      session: ({ session, token }) => {
        const role = InteractiveUserRoleSchema.safeParse(token.role);
        if (role.success && token.sub !== undefined) {
          session.user.id = token.sub;
          session.user.role = role.data;
        }
        return session;
      },
    },
    cookies: {
      sessionToken: {
        name: sessionCookieName,
        options: {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: useSecureCookies,
        },
      },
    },
    pages: {
      error: "/login",
      signIn: "/login",
    },
    providers: [
      CredentialsProvider({
        credentials: {
          email: { label: "邮箱", type: "email" },
          password: { label: "密码", type: "password" },
        },
        name: "内部账号",
        async authorize(credentials) {
          if (credentials === undefined) return null;
          return dependencies.authenticate(
            { email: credentials.email, password: credentials.password },
            randomUUID(),
          );
        },
      }),
    ],
    ...(secret === undefined ? {} : { secret }),
    session: {
      maxAge: 8 * 60 * 60,
      strategy: "jwt",
    },
    useSecureCookies,
  };
}
