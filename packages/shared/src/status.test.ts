import { describe, expect, it } from "vitest";

import { createServiceStatus, ServiceStatusSchema } from "./status";

describe("ServiceStatusSchema", () => {
  it.each(["web", "worker"] as const)("accepts the %s service", (service) => {
    expect(createServiceStatus(service)).toEqual({
      service,
      status: "available",
    });
  });

  it("rejects unsupported service names", () => {
    expect(() => ServiceStatusSchema.parse({ service: "database", status: "available" })).toThrow();
  });
});
