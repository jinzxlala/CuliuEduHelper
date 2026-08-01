import { describe, expect, it } from "vitest";

import { ServiceStatusSchema } from "@culiu/shared";

import { buildWorkerHealth } from "./health";

describe("buildWorkerHealth", () => {
  it("returns a schema-valid worker status", () => {
    const status = buildWorkerHealth();

    expect(ServiceStatusSchema.parse(status)).toEqual({
      service: "worker",
      status: "available",
    });
  });
});
