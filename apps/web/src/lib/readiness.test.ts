import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildWebReadiness, type ReadinessProbes } from "./readiness";

function probes(overrides: Partial<ReadinessProbes> = {}): ReadinessProbes {
  const available = (): Promise<void> => Promise.resolve();
  return {
    database: available,
    meilisearch: available,
    objectStorage: available,
    redis: available,
    ...overrides,
  };
}

describe("web readiness", () => {
  it("reports ready only when every required dependency is available", async () => {
    const result = await buildWebReadiness(probes(), new Date("2026-08-02T00:00:00.000Z"));

    expect(result).toEqual({
      checkedAt: "2026-08-02T00:00:00.000Z",
      checks: {
        database: "available",
        meilisearch: "available",
        objectStorage: "available",
        redis: "available",
      },
      service: "web",
      status: "ready",
    });
  });

  it("reports the failed dependency without exposing its error message", async () => {
    const result = await buildWebReadiness(
      probes({ database: () => Promise.reject(new Error("secret connection detail")) }),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(result.status).toBe("not_ready");
    expect(result.checks.database).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("secret connection detail");
  });
});
