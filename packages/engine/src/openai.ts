import { sha256 } from "@semantic-ir/semantic-ir";
import type {
  CostMetrics, ModelAdapter, ModelCapabilities, ModelFingerprint,
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

export class OpenAIAdapter implements ModelAdapter {
  private resolvedModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly price: OpenAIPrice | null;

  constructor(readonly model: string, options: {
    apiKey?: string;
    baseUrl?: string;
    price?: OpenAIPrice | null;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.price = options.price ?? null;
    this.resolvedModel = model;
  }

  private async request(path: string, body: object, timeoutMs = 60_000): Promise<Response> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for provider calls");
    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { authorization: "Bearer " + this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Do not include provider response bodies: they may contain request content.
      throw new Error("OpenAI request failed with HTTP " + response.status);
    }
    return response;
  }

  async forwardChatRaw(body: object): Promise<Response> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for provider calls");
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
      tokenCounting: true, reasoningMetadata: true, structuredOutput: false,
      tools: false, streaming: false, contextSize: null, tokenizerId: null,
    };
  }

  async getModelFingerprint(): Promise<ModelFingerprint> {
    const capabilities = this.getCapabilities();
    return {
      provider: "openai", model: this.model, snapshot: this.resolvedModel,
      capabilities, fingerprintSha256: sha256(JSON.stringify({
        provider: "openai", model: this.model, snapshot: this.resolvedModel, capabilities,
      })),
      observedAt: new Date().toISOString(),
    };
  }
}
