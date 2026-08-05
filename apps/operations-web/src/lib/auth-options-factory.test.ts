import { describe, expect, it, vi } from "vitest";

import { createAuthOptions } from "./auth-options-factory";

const authenticate = vi.fn(() => Promise.resolve(null));

describe("Auth.js options", () => {
  it("uses credentials, JWT sessions, the custom login page, and an eight-hour maximum", () => {
    const options = createAuthOptions(
      { authenticate },
      {
        NEXTAUTH_SECRET: "synthetic-secret-with-at-least-32-bytes",
        NEXTAUTH_URL: "http://127.0.0.1:3000",
      },
    );
    expect(options.providers).toHaveLength(1);
    expect(options.providers[0]?.id).toBe("credentials");
    expect(options.session).toMatchObject({ maxAge: 28_800, strategy: "jwt" });
    expect(options.pages).toEqual({ error: "/login", signIn: "/login" });
    expect(options.useSecureCookies).toBe(false);
    expect(options.cookies?.sessionToken?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    });
  });

  it("requires secure cookies when the configured origin uses HTTPS", () => {
    const options = createAuthOptions(
      { authenticate },
      {
        NEXTAUTH_SECRET: "synthetic-secret-with-at-least-32-bytes",
        NEXTAUTH_URL: "https://internal.example.invalid",
      },
    );
    expect(options.useSecureCookies).toBe(true);
    expect(options.cookies?.sessionToken).toMatchObject({
      name: "__Secure-next-auth.session-token",
      options: { httpOnly: true, sameSite: "lax", secure: true },
    });
  });

  it("uses a system-specific cookie name and preserves the secure prefix rule", () => {
    const options = createAuthOptions(
      { authenticate },
      {
        CULIU_AUTH_COOKIE_NAME: "culiu-operations.session-token",
        NEXTAUTH_SECRET: "synthetic-secret-with-at-least-32-bytes",
        NEXTAUTH_URL: "https://operations.example.invalid",
      },
    );
    expect(options.cookies?.sessionToken?.name).toBe("__Secure-culiu-operations.session-token");
  });

  it("rejects a configured secret shorter than 32 bytes", () => {
    expect(() =>
      createAuthOptions(
        { authenticate },
        { NEXTAUTH_SECRET: "too-short", NEXTAUTH_URL: "https://internal.example.invalid" },
      ),
    ).toThrow("at least 32 bytes");
  });

  it("fails closed to secure cookies for production when no origin is configured", () => {
    const options = createAuthOptions(
      { authenticate },
      { NEXTAUTH_SECRET: "synthetic-secret-with-at-least-32-bytes", NODE_ENV: "production" },
    );
    expect(options.useSecureCookies).toBe(true);
  });

  it("keeps redirects on the configured application origin", () => {
    const options = createAuthOptions({ authenticate });
    const redirect = options.callbacks?.redirect;
    if (redirect === undefined) throw new Error("Redirect callback is required.");
    expect(
      redirect({ baseUrl: "https://internal.example.invalid", url: "https://attacker.invalid" }),
    ).toBe("https://internal.example.invalid");
    expect(redirect({ baseUrl: "https://internal.example.invalid", url: "/students" })).toBe(
      "https://internal.example.invalid/students",
    );
  });
});
