import { describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PROFILE_MODEL,
  DeepSeekJsonModelProvider,
  ModelGatewayError,
  parseDeepSeekGatewayConfig,
} from "./gateway.js";

const config = { apiKey: "synthetic_test_key_not_real", maxTokens: 2_048, timeoutMs: 2_000 };

describe("DeepSeekJsonModelProvider", () => {
  it("uses the fixed V4 Flash JSON Output contract and normalizes usage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          id: "synthetic-request",
          model: DEEPSEEK_PROFILE_MODEL,
          usage: {
            completion_tokens: 8,
            prompt_cache_hit_tokens: 20,
            prompt_cache_miss_tokens: 80,
            prompt_tokens: 100,
            total_tokens: 108,
          },
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      ),
    );
    const provider = new DeepSeekJsonModelProvider(config, fetchMock);
    const result = await provider.generateJson({
      systemPrompt: "Return json.",
      userPrompt: "Synthetic input.",
    });

    expect(result.json).toEqual({ ok: true });
    expect(result.usage.promptCacheMissTokens).toBe(80);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: DEEPSEEK_PROFILE_MODEL,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
  });

  it("never includes the API key or provider body in public errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("sensitive provider details", { status: 500 }));
    const provider = new DeepSeekJsonModelProvider(config, fetchMock);

    await expect(
      provider.generateJson({ systemPrompt: "Return json.", userPrompt: "Synthetic input." }),
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });
    await provider
      .generateJson({ systemPrompt: "Return json.", userPrompt: "Synthetic input." })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(ModelGatewayError);
        expect(String(error)).not.toContain(config.apiKey);
        expect(String(error)).not.toContain("sensitive provider details");
      });
  });

  it("rejects empty content, incomplete output and inconsistent usage", async () => {
    for (const body of [
      {
        choices: [{ finish_reason: "stop", message: { content: "" } }],
        id: "empty",
        model: DEEPSEEK_PROFILE_MODEL,
        usage: { completion_tokens: 0, prompt_tokens: 1, total_tokens: 1 },
      },
      {
        choices: [{ finish_reason: "length", message: { content: "{}" } }],
        id: "cut-off",
        model: DEEPSEEK_PROFILE_MODEL,
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      },
      {
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        id: "bad-usage",
        model: DEEPSEEK_PROFILE_MODEL,
        usage: {
          completion_tokens: 1,
          prompt_cache_hit_tokens: 1,
          prompt_cache_miss_tokens: 1,
          prompt_tokens: 3,
          total_tokens: 4,
        },
      },
    ]) {
      const provider = new DeepSeekJsonModelProvider(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        ),
      );
      await expect(
        provider.generateJson({ systemPrompt: "Return json.", userPrompt: "Synthetic input." }),
      ).rejects.toBeInstanceOf(ModelGatewayError);
    }
  });
});

describe("parseDeepSeekGatewayConfig", () => {
  it("requires a non-placeholder-length server-side key", () => {
    expect(
      parseDeepSeekGatewayConfig({ DEEPSEEK_API_KEY: "synthetic_test_key_not_real" }),
    ).toMatchObject({ maxTokens: 4_096, timeoutMs: 45_000 });
    expect(() => parseDeepSeekGatewayConfig({ DEEPSEEK_API_KEY: "short" })).toThrow();
  });
});
