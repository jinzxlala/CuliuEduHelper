import { describe, expect, it } from "vitest";

import { parseRedisUrl } from "./redis.js";

describe("parseRedisUrl", () => {
  it("accepts redis and rediss protocols", () => {
    expect(parseRedisUrl({ REDIS_URL: "redis://127.0.0.1:6379" })).toBe("redis://127.0.0.1:6379");
    expect(parseRedisUrl({ REDIS_URL: "rediss://redis.example.invalid:6380" })).toBe(
      "rediss://redis.example.invalid:6380",
    );
  });

  it("rejects HTTP URLs", () => {
    expect(() => parseRedisUrl({ REDIS_URL: "https://example.invalid" })).toThrow();
  });
});
