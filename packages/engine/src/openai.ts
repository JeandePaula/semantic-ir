import { sha256 } from "@semantic-ir/semantic-ir";
import type {
  BudgetPreflight, CostMetrics, ModelAdapter, ModelCapabilities, ModelFingerprint,
  ModelRequest, ModelResponse, TokenCount, UsageMetrics,
} from "@semantic-ir/core";

export interface OpenAIPrice {
  readonly version: string;
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

interface ResponseJson {
  id?: string;
  model?: string;
  status?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ChatResponseJson {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export class OpenAIAdapter implements ModelAdapter {
  private resolvedModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly price: OpenAIPrice | null;
  readonly provider: "openai" | "openrouter";

  constructor(readonly model: string, options: {
    apiKey?: string;
    baseUrl?: string;
    price?: OpenAIPrice | null;
    provider?: "openai" | "openrouter";
  } = {}) {
    this.provider = options.provider ?? "openai";
    this.apiKey = options.apiKey ?? (this.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY) ?? "";
    this.baseUrl = (options.baseUrl ?? (this.provider === "openrouter"
      ? "https://openrouter.ai/api" : "https://api.openai.com")).replace(/\/$/, "");
    this.price = options.price ?? null;
    this.resolvedModel = model;
  }

  private async request(path: string, body: object, timeoutMs = 60_000): Promise<Response> {
    if (!this.apiKey) throw new Error(this.provider.toUpperCase() + " API key is required for provider calls");
    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.apiKey, "content-type": "application/json",
        ...(this.provider === "openrouter" && this.price ? { "X-OpenRouter-Cache": "false" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Do not include provider response bodies: they may contain request content.
      const rawRetryAfter = response.headers.get("retry-after");
      const seconds = Number(rawRetryAfter);
      const retryAfterMs = rawRetryAfter === null ? null : Number.isFinite(seconds)
        ? Math.max(0, seconds * 1_000)
        : Math.max(0, Date.parse(rawRetryAfter) - Date.now());
      throw Object.assign(new Error(this.provider + " request failed with HTTP " + response.status), {
        status: response.status, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
      });
    }
    return response;
  }

  /** Catalog prices are a routing ceiling, never a substitute for measured billing. */
  async discoverOpenRouterPrice(): Promise<OpenAIPrice> {
    if (this.provider !== "openrouter") throw new Error("OpenRouter pricing requested for another provider");
    if (!this.apiKey) throw new Error("OPENROUTER API key is required");
    const [author, ...slugParts] = this.model.split("/");
    if (!author || !slugParts.length) throw new Error("Invalid OpenRouter model slug");
    const response = await fetch(this.baseUrl + "/v1/model/" +
      encodeURIComponent(author) + "/" + encodeURIComponent(slugParts.join("/")), {
      headers: { authorization: "Bearer " + this.apiKey }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("OpenRouter model pricing request failed with HTTP " + response.status);
    const body = await response.json() as {
      data?: { pricing?: { prompt?: string; completion?: string; request?: string } };
    };
    const raw = body.data?.pricing;
    const input = Number(raw?.prompt);
    const output = Number(raw?.completion);
    const perRequest = Number(raw?.request ?? "0");
    if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0 ||
        !Number.isFinite(perRequest) || perRequest !== 0) {
      throw new Error("OpenRouter model has unsupported or unavailable text pricing");
    }
    return {
      version: "openrouter-catalog-" + sha256(JSON.stringify(raw)).slice(0, 12),
      inputUsdPerMillion: input * 1_000_000,
      cachedInputUsdPerMillion: input * 1_000_000,
      outputUsdPerMillion: output * 1_000_000,
    };
  }

  async preflight(request: ModelRequest): Promise<BudgetPreflight | null> {
    if (this.provider !== "openrouter" || !this.price || !request.maxOutputTokens) return null;
    // Includes generous room for chat framing. Checked against provider usage after each call.
    // This is a conservative estimate, not a verified tokenizer or a hard provider guarantee.
    const upperInputTokens = 256 + 2 * Buffer.byteLength(request.prompt, "utf8");
    return {
      upperInputTokens,
      upperCostUsd: (upperInputTokens * this.price.inputUsdPerMillion +
        request.maxOutputTokens * this.price.outputUsdPerMillion) / 1_000_000,
      method: "conservative_byte_envelope",
    };
  }

  async forwardChatRaw(body: object): Promise<Response> {
    if (!this.apiKey) throw new Error(this.provider.toUpperCase() + " API key is required for provider calls");
    return fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  async forwardChatCompletions(body: object): Promise<{ status: number; body: unknown }> {
    const response = await this.forwardChatRaw(body);
    return { status: response.status, body: await response.json() as unknown };
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const start = performance.now();
    if (this.provider === "openrouter") {
      const response = await this.request("/v1/chat/completions", {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        usage: { include: true },
        ...(this.price ? { provider: { max_price: {
          prompt: this.price.inputUsdPerMillion,
          completion: this.price.outputUsdPerMillion,
        } } } : {}),
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      }, request.timeoutMs);
      const body = await response.json() as ChatResponseJson;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("openrouter response did not contain text");
      this.resolvedModel = body.model ?? this.resolvedModel;
      const usage = body.usage;
      return {
        text: content,
        usage: {
          inputTokens: usage?.prompt_tokens ?? null,
          cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
          outputTokens: usage?.completion_tokens ?? null,
          reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null,
          source: usage ? "provider_usage" : "unavailable",
        },
        ...(typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
          ? { cost: { amountUsd: usage.cost, status: "measured" as const,
              priceVersion: null, category: "user_inference" as const } } : {}),
        latencyMs: Math.round(performance.now() - start),
        providerRequestId: body.id ?? null,
        modelFingerprint: await this.getModelFingerprint(),
      };
    }
    const response = await this.request("/v1/responses", {
      model: request.model,
      input: request.prompt,
      store: false,
      ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    }, request.timeoutMs);
    const body = await response.json() as ResponseJson;
    const latencyMs = Math.round(performance.now() - start);
    if (body.status !== "completed") throw new Error("Provider response did not complete");
    this.resolvedModel = body.model ?? this.resolvedModel;
    const text = (body.output ?? []).flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text ?? "").join("");
    const usage = body.usage;
    return {
      text,
      usage: {
        inputTokens: usage?.input_tokens ?? null,
        cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
        source: usage ? "provider_usage" : "unavailable",
      },
      latencyMs,
      providerRequestId: body.id ?? null,
      modelFingerprint: await this.getModelFingerprint(),
    };
  }

  async countTokens(request: ModelRequest): Promise<TokenCount | null> {
    if (this.provider === "openrouter") return null;
    try {
      const response = await this.request("/v1/responses/input_tokens", {
        model: request.model, input: request.prompt,
      }, request.timeoutMs);
      const body = await response.json() as { input_tokens?: number };
      return typeof body.input_tokens === "number"
        ? { inputTokens: body.input_tokens, source: "provider_count_endpoint" } : null;
    } catch {
      return null;
    }
  }

  estimateCost(usage: UsageMetrics): CostMetrics | null {
    if (!this.price || usage.inputTokens === null || usage.outputTokens === null) return null;
    const cached = usage.cachedInputTokens ?? 0;
    if (cached > usage.inputTokens) return null;
    const amountUsd = ((usage.inputTokens - cached) * this.price.inputUsdPerMillion +
      cached * this.price.cachedInputUsdPerMillion +
      usage.outputTokens * this.price.outputUsdPerMillion) / 1_000_000;
    return {
      amountUsd, status: "estimated", priceVersion: this.price.version,
      category: "user_inference",
    };
  }

  getCapabilities(): ModelCapabilities {
    return {
      tokenCounting: this.provider === "openai", reasoningMetadata: true, structuredOutput: false,
      tools: false, streaming: false, contextSize: null, tokenizerId: null,
    };
  }

  async getModelFingerprint(): Promise<ModelFingerprint> {
    const capabilities = this.getCapabilities();
    return {
      provider: this.provider, model: this.model, snapshot: this.resolvedModel,
      capabilities, fingerprintSha256: sha256(JSON.stringify({
        provider: this.provider, model: this.model, snapshot: this.resolvedModel, capabilities,
        price: this.price,
      })),
      observedAt: new Date().toISOString(),
    };
  }
}
