import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { OpenAIAdapter, RuntimeRouter, type SqliteStore } from "@semantic-ir/engine";
import type { UsageMetrics } from "@semantic-ir/core";
import { adapterFor, providerFor } from "./service.js";

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return JSON.parse(body) as unknown;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

export function createGateway(store: SqliteStore) {
  return createServer(async (request, response) => {
    try {
      const expectedKey = process.env.SEMANTIC_IR_GATEWAY_KEY;
      if (expectedKey && request.headers.authorization !== "Bearer " + expectedKey) {
        send(response, 401, { error: { message: "Unauthorized" } });
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && request.url === "/metrics") {
        send(response, 200, store.metricsSummary());
        return;
      }
      if (request.method === "GET" && request.url === "/dashboard") {
        const metrics = store.metricsSummary();
        const rows = metrics.byScope.map((item) =>
          "<tr><td>" + escapeHtml(item.scope) + "</td><td>" + item.requests + "</td></tr>").join("");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'",
        });
        response.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">" +
          "<title>Semantic IR metrics</title><h1>Semantic IR</h1>" +
          "<p>Provider: " + escapeHtml(providerFor(store)) + "</p>" +
          "<p>Default model: " + escapeHtml(store.getSetting<string>("defaultModel") ?? "unconfigured") + "</p>" +
          "<p>Observed requests: " + metrics.requests + "</p>" +
          "<p>Fallbacks: " + metrics.fallbacks + "</p>" +
          "<p>Measured inference cost (USD): " +
          (metrics.measuredCostUsd === null ? "unavailable" : metrics.measuredCostUsd.toFixed(8)) + "</p>" +
          "<p>Estimated inference cost (USD): " +
          (metrics.estimatedCostUsd === null ? "unavailable" : metrics.estimatedCostUsd.toFixed(8)) + "</p>" +
          "<p>Verified savings: unavailable</p>" +
          "<p>Host primary prompt optimization: unavailable</p>" +
          "<table><tr><th>Optimization scope</th><th>Requests</th></tr>" + rows + "</table></html>");
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        send(response, 404, { error: { message: "Not found" } });
        return;
      }
      const payload = await readJson(request);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        send(response, 400, { error: { message: "Expected JSON object" } });
        return;
      }
      const body = payload as Record<string, unknown>;
      if (typeof body.model !== "string" || !Array.isArray(body.messages)) {
        send(response, 400, { error: { message: "model and messages are required" } });
        return;
      }
      const adapter: OpenAIAdapter = adapterFor(store, body.model);
      const messages = body.messages as unknown[];
      const singleUser = messages.length === 1 && typeof messages[0] === "object" &&
        messages[0] !== null && (messages[0] as Record<string, unknown>).role === "user" &&
        typeof (messages[0] as Record<string, unknown>).content === "string";
      const supportedKeys = new Set(["model", "messages", "max_completion_tokens"]);
      const supported = singleUser && Object.keys(body).every((key) => supportedKeys.has(key)) &&
        (body.max_completion_tokens === undefined ||
          (Number.isInteger(body.max_completion_tokens) && Number(body.max_completion_tokens) > 0));
      if (!supported) {
        // Preserve every unsupported chat field by forwarding the exact parsed body.
        const started = performance.now();
        const upstream = await adapter.forwardChatRaw(body);
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        let captured = "";
        const decoder = new TextDecoder();
        const isEventStream = upstream.headers.get("content-type")?.includes("text/event-stream") ?? false;
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            response.write(chunk);
            if (!isEventStream && captured.length < 1_000_000) {
              captured += decoder.decode(chunk, { stream: true });
            }
          }
        }
        if (!isEventStream) captured += decoder.decode();
        response.end();
        let usage: UsageMetrics = {
          inputTokens: null, cachedInputTokens: null, outputTokens: null,
          reasoningTokens: null, totalTokens: null, source: "unavailable",
        };
        try {
          const parsed = JSON.parse(captured) as {
            usage?: {
              prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };
          if (parsed.usage) {
            usage = {
              inputTokens: parsed.usage.prompt_tokens ?? null,
              cachedInputTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? null,
              outputTokens: parsed.usage.completion_tokens ?? null,
              reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? null,
              totalTokens: parsed.usage.total_tokens ?? null, source: "provider_usage",
            };
          }
        } catch { /* streaming or non-JSON provider body */ }
        store.recordMetric({
          requestId: randomUUID(), scope: "application_request", model: body.model,
          taskClass: "unknown", codecId: null, fallbackReason: "unsupported_chat_feature",
          usage, cost: adapter.estimateCost(usage),
          latencyMs: Math.round(performance.now() - started),
        });
        return;
      }
      const prompt = (messages[0] as { content: string }).content;
      const router = new RuntimeRouter(adapter, store);
      const routed = await router.invoke(prompt, {
        scope: "application_request",
        ...(typeof body.max_completion_tokens === "number"
          ? { maxOutputTokens: body.max_completion_tokens } : {}),
      });
      const usage: UsageMetrics = routed.response.usage;
      send(response, 200, {
        id: routed.response.providerRequestId ?? "semanticir_" + randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: routed.response.text },
          finish_reason: "stop" }],
        usage: {
          prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
          completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
        },
        semantic_ir: {
          scope: "application_request", codec: routed.decision.codecVersion,
          fallback_reason: routed.decision.fallbackReason,
          cost: routed.response.cost ?? adapter.estimateCost(usage),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      send(response, /JSON|body too large|Expected/.test(message) ? 400 : 502,
        { error: { message } });
    }
  });
}
