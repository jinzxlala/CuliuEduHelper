import { z } from "zod";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_PROFILE_MODEL = "deepseek-v4-flash";

const DeepSeekEnvironmentSchema = z
  .object({
    DEEPSEEK_API_KEY: z.string().trim().min(20),
    DEEPSEEK_PROFILE_MAX_TOKENS: z.coerce.number().int().min(512).max(16_384).default(4_096),
    DEEPSEEK_PROFILE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
  })
  .loose();

const UsageSchema = z.looseObject({
  completion_tokens: z.number().int().nonnegative(),
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

const CompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.looseObject({ content: z.string().nullable() }),
      }),
    )
    .min(1),
  id: z.string().min(1).max(256),
  model: z.string().min(1).max(128),
  usage: UsageSchema,
});

export interface JsonModelUsage {
  readonly completionTokens: number;
  readonly promptCacheHitTokens: number;
  readonly promptCacheMissTokens: number;
  readonly promptTokens: number;
  readonly totalTokens: number;
}

export interface JsonModelResult {
  readonly json: unknown;
  readonly model: string;
  readonly providerRequestId: string;
  readonly usage: JsonModelUsage;
}

export interface JsonModelRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface JsonModelProvider {
  generateJson(request: JsonModelRequest): Promise<JsonModelResult>;
}

export interface DeepSeekGatewayConfig {
  readonly apiKey: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export class ModelGatewayError extends Error {
  readonly code: "empty_output" | "invalid_output" | "provider_error" | "timeout";
  readonly retryable: boolean;

  constructor(
    code: ModelGatewayError["code"],
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelGatewayError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function parseDeepSeekGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DeepSeekGatewayConfig {
  const parsed = DeepSeekEnvironmentSchema.parse(environment);
  return {
    apiKey: parsed.DEEPSEEK_API_KEY,
    maxTokens: parsed.DEEPSEEK_PROFILE_MAX_TOKENS,
    timeoutMs: parsed.DEEPSEEK_PROFILE_TIMEOUT_MS,
  };
}

export class DeepSeekJsonModelProvider implements JsonModelProvider {
  readonly #config: DeepSeekGatewayConfig;
  readonly #fetch: typeof fetch;

  constructor(config: DeepSeekGatewayConfig, fetchImplementation: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  async generateJson(request: JsonModelRequest): Promise<JsonModelResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#config.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        body: JSON.stringify({
          max_tokens: this.#config.maxTokens,
          messages: [
            { content: request.systemPrompt, role: "system" },
            { content: request.userPrompt, role: "user" },
          ],
          model: DEEPSEEK_PROFILE_MODEL,
          response_format: { type: "json_object" },
          stream: false,
          temperature: 0.2,
          thinking: { type: "disabled" },
        }),
        headers: {
          Authorization: `Bearer ${this.#config.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelGatewayError("timeout", "Model request timed out.", {
          cause: error,
          retryable: true,
        });
      }
      throw new ModelGatewayError("provider_error", "Model provider could not be reached.", {
        cause: error,
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new ModelGatewayError(
        "provider_error",
        `Model provider returned HTTP ${String(response.status)}.`,
        { retryable: response.status === 408 || response.status === 429 || response.status >= 500 },
      );
    }

    let envelope: z.infer<typeof CompletionResponseSchema>;
    try {
      envelope = CompletionResponseSchema.parse(await response.json());
    } catch (error) {
      throw new ModelGatewayError("invalid_output", "Model response envelope was invalid.", {
        cause: error,
      });
    }
    const choice = envelope.choices[0];
    if (choice === undefined || choice.finish_reason !== "stop") {
      throw new ModelGatewayError("invalid_output", "Model response was incomplete.");
    }
    const content = choice.message.content?.trim();
    if (content === undefined || content === "") {
      throw new ModelGatewayError("empty_output", "Model returned empty JSON content.", {
        retryable: true,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (error) {
      throw new ModelGatewayError("invalid_output", "Model content was not valid JSON.", {
        cause: error,
      });
    }
    const cacheHit = envelope.usage.prompt_cache_hit_tokens ?? 0;
    const cacheMiss = envelope.usage.prompt_cache_miss_tokens ?? envelope.usage.prompt_tokens;
    if (cacheHit + cacheMiss !== envelope.usage.prompt_tokens) {
      throw new ModelGatewayError("invalid_output", "Model usage totals were inconsistent.");
    }
    return {
      json,
      model: envelope.model,
      providerRequestId: envelope.id,
      usage: {
        completionTokens: envelope.usage.completion_tokens,
        promptCacheHitTokens: cacheHit,
        promptCacheMissTokens: cacheMiss,
        promptTokens: envelope.usage.prompt_tokens,
        totalTokens: envelope.usage.total_tokens,
      },
    };
  }
}
