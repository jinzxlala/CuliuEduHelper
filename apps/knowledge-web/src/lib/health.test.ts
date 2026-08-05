import { describe, expect, it } from "vitest";

import { ServiceStatusSchema } from "@culiu/shared";

import { buildWebHealth } from "./health";

describe("buildWebHealth", () => {
  it("returns a schema-valid web status", () => {
    const status = buildWebHealth();

    expect(ServiceStatusSchema.parse(status)).toEqual({
      service: "knowledge-web",
      status: "available",
    });
  });
});
