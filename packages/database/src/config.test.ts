import { describe, expect, it } from "vitest";

import { parseDatabaseConfig } from "./config.js";

describe("parseDatabaseConfig", () => {
  it("accepts a PostgreSQL URL and bounded pool size", () => {
    expect(
      parseDatabaseConfig({
        DATABASE_POOL_MAX: "12",
        DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/database",
      }),
    ).toEqual({
      connectionString: "postgresql://user:password@127.0.0.1:5432/database",
      maxConnections: 12,
    });
  });

  it("rejects non-PostgreSQL protocols", () => {
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: "https://example.invalid/database" }),
    ).toThrow();
  });

  it("rejects an excessive pool size", () => {
    expect(() =>
      parseDatabaseConfig({
        DATABASE_POOL_MAX: "100",
        DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/database",
      }),
    ).toThrow();
  });
});
