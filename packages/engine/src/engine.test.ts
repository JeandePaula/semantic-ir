import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@semantic-ir/semantic-ir";
import { analyzePrompt } from "@semantic-ir/core";
import type {
  ModelAdapter, ModelCapabilities, ModelFingerprint, ModelRequest,
  ModelResponse, TokenCount, UsageMetrics,
} from "@semantic-ir/core";
import {
  compilePrompt, CodecDefinitionSchema, DEFAULT_CODECS, validateCompiled, SqliteStore,
  RuntimeRouter, EvolutionaryOptimizer, SYNTHETIC_SUITE, OpenAIAdapter,
} from "./index.js";

class FakeAdapter implements ModelAdapter {
  snapshot = "fake-1";
  calls: string[] = [];
  getCapabilities(): ModelCapabilities {
    return { tokenCounting: true, reasoningMetadata: true, structuredOutput: false,
      tools: false, streaming: false, contextSize: 4096, tokenizerId: "fake" };
  }
  async getModelFingerprint(): Promise<ModelFingerprint> {
    const capabilities = this.getCapabilities();
    return { provider: "fake", model: "test", snapshot: this.snapshot,
      capabilities, fingerprintSha256: sha256(this.snapshot), observedAt: "2026-01-01" };
  }
  async countTokens(request: ModelRequest): Promise<TokenCount> {
    return { inputTokens: request.prompt.length, source: "official_tokenizer" };
  }
  estimateCost(usage: UsageMetrics) {
    if (usage.inputTokens === null || usage.outputTokens === null) return null;
    return { amountUsd: (usage.inputTokens + usage.outputTokens) / 1_000_000,
      status: "estimated" as const, priceVersion: "test", category: "user_inference" as const };
  }
  async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request.prompt);
    const output = ["BLUE", "8500", "GREEN", "42"].find((word) => request.prompt.includes(word)) ?? "OK";
    const usage: UsageMetrics = { inputTokens: request.prompt.length,
      cachedInputTokens: 0, outputTokens: output.length, reasoningTokens: 0,
      totalTokens: request.prompt.length + output.length, source: "provider_usage" };
    return { text: output, usage, latencyMs: 10, providerRequestId: null,
      modelFingerprint: await this.getModelFingerprint() };
  }
}

describe("engine", () => {
  it("rejects executable or unknown codec fields", () => {
    expect(() => CodecDefinitionSchema.parse({
      ...DEFAULT_CODECS[1], execute: "require('fs').readFileSync('/etc/passwd')",
    })).toThrow();
    expect(() => CodecDefinitionSchema.parse({
      ...DEFAULT_CODECS[1], separator: ";\nprocess.exit()",
    })).toThrow();
  });
  it("compiles a source-bound codec and rejects literal/constraint loss", () => {
    const ir = analyzePrompt("Change 7500.  Never touch https://example.com/a.");
    const spacing = DEFAULT_CODECS[1];
    expect(spacing).toBeDefined();
    const compiled = compilePrompt(ir, spacing!);
    expect(compiled.text).toContain("7500");
    expect(compiled.text).toContain("Never touch https://example.com/a");
    expect(validateCompiled(ir, { ...compiled, text: compiled.text.replace("7500", "8500") }))
      .toContainEqual(expect.stringMatching(/^literal_corruption/));
    expect(validateCompiled(ir, { ...compiled, text: compiled.text.replace("Never", "Maybe") }))
      .toContain("constraint_loss:C0");
  });

  it("falls back without a stable profile, uses a promoted codec, and detects drift", async () => {
    const store = new SqliteStore(":memory:");
    const adapter = new FakeAdapter();
    const router = new RuntimeRouter(adapter, store);
    const prompt = "Extract the number  8500.";
    expect((await router.decide(prompt)).decision.fallbackReason).toBe("no_stable_profile");
    store.promote(await adapter.getModelFingerprint(), "extraction", DEFAULT_CODECS[1]!);
    const routed = await router.invoke(prompt);
    expect(routed.decision.mode).toBe("compiled");
    expect(adapter.calls.at(-1)).toBe("Extract the number 8500.");
    expect(store.metricsSummary().byScope).toEqual([{ scope: "application_request", requests: 1 }]);
    adapter.snapshot = "fake-2";
    expect((await router.decide(prompt)).decision.fallbackReason).toBe("model_fingerprint_changed");
    expect(store.getProfile("fake", "test", "extraction")?.status).toBe("needs_reverification");
    store.close();
  });

  it("keeps calibration inside the budget and promotes only after holdout", async () => {
    const store = new SqliteStore(":memory:");
    const adapter = new FakeAdapter();
    const optimizer = new EvolutionaryOptimizer(adapter, store);
    const run = await optimizer.optimize({
      fingerprint: await adapter.getModelFingerprint(), taskClass: "extraction",
      suite: SYNTHETIC_SUITE,
      seeds: DEFAULT_CODECS.map((definition) => ({
        id: definition.id, version: "0.1.0", definition,
        definitionSha256: "", status: "experimental", parentVersion: null,
      })),
      budget: { maxRequests: 100, maxTokens: 20_000, maxCostUsd: 1, maxDurationMs: 60_000 },
    });
    expect(run.status).toBe("completed");
    expect(run.usedRequests).toBeLessThanOrEqual(100);
    expect(optimizer.lastReport?.holdout).toHaveLength(1);
    expect(optimizer.lastReport?.selectedCodecId).toBe("spacing");
    expect(store.getProfile("fake", "test", "extraction")?.codecId).toBe("spacing");
    store.close();
  });

  it("does not exceed a tiny request budget or promote", async () => {
    const store = new SqliteStore(":memory:");
    const adapter = new FakeAdapter();
    const optimizer = new EvolutionaryOptimizer(adapter, store);
    const run = await optimizer.optimize({
      fingerprint: await adapter.getModelFingerprint(), taskClass: "extraction",
      suite: SYNTHETIC_SUITE, seeds: [{
        id: DEFAULT_CODECS[0]!.id, version: "0.1.0", definition: DEFAULT_CODECS[0]!,
        definitionSha256: "", status: "experimental", parentVersion: null,
      }],
      budget: { maxRequests: 1, maxTokens: 100, maxCostUsd: 1, maxDurationMs: 60_000 },
    });
    expect(run.status).toBe("budget_exhausted");
    expect(run.usedRequests).toBeLessThanOrEqual(1);
    expect(adapter.calls).toHaveLength(0);
    expect(store.listProfiles()).toHaveLength(0);
    store.close();
  });

  it("rejects task classes without scored cases before making provider calls", async () => {
    const store = new SqliteStore(":memory:");
    const adapter = new FakeAdapter();
    const optimizer = new EvolutionaryOptimizer(adapter, store);
    const run = await optimizer.optimize({
      fingerprint: await adapter.getModelFingerprint(), taskClass: "coding",
      suite: SYNTHETIC_SUITE, seeds: [],
      budget: { maxRequests: 10, maxTokens: 1000, maxCostUsd: 1, maxDurationMs: 1000 },
    });
    expect(run.status).toBe("failed");
    expect(optimizer.lastReport?.selectionReason).toMatch(/No scored calibration cases/);
    expect(adapter.calls).toHaveLength(0);
    store.close();
  });

  it("rolls back to the previous stable codec", async () => {
    const store = new SqliteStore(":memory:");
    const adapter = new FakeAdapter();
    const fingerprint = await adapter.getModelFingerprint();
    store.promote(fingerprint, "extraction", DEFAULT_CODECS[1]!);
    store.promote(fingerprint, "extraction", DEFAULT_CODECS[2]!);
    expect(store.rollback("fake", "test", "extraction")).toBe("spacing");
    expect(store.getProfile("fake", "test", "extraction")?.codecId).toBe("spacing");
    store.close();
  });

  it("refuses rollback across model fingerprints or a drifted profile", async () => {
    const store = new SqliteStore(":memory:");
    const adapter = new FakeAdapter();
    store.promote(await adapter.getModelFingerprint(), "extraction", DEFAULT_CODECS[1]!);
    adapter.snapshot = "fake-2";
    store.promote(await adapter.getModelFingerprint(), "extraction", DEFAULT_CODECS[2]!);
    expect(store.rollback("fake", "test", "extraction")).toBeNull();
    store.markDrift("fake", "test", "extraction");
    expect(store.rollback("fake", "test", "extraction")).toBeNull();
    store.close();
  });

  it("migrates old profile history and preserves profiles across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-ir-store-"));
    const path = join(dir, "profiles.sqlite");
    try {
      const oldDb = new DatabaseSync(path);
      oldDb.exec(`CREATE TABLE profile_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL,
        model TEXT NOT NULL, task_class TEXT NOT NULL, codec_id TEXT NOT NULL,
        event TEXT NOT NULL, occurred_at TEXT NOT NULL
      )`);
      oldDb.close();
      const adapter = new FakeAdapter();
      const store = new SqliteStore(path);
      store.promote(await adapter.getModelFingerprint(), "extraction", DEFAULT_CODECS[1]!);
      store.close();
      const reopened = new SqliteStore(path);
      expect(reopened.getProfile("fake", "test", "extraction")?.codecId).toBe("spacing");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OpenAI adapter response accounting", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses provider usage and does not double count reasoning or cached tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "resp_1", model: "test-snapshot", status: "completed",
      output: [{ content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 30 } },
    }), { status: 200 })));
    const adapter = new OpenAIAdapter("test", { apiKey: "test-key",
      price: { version: "fixture", inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 } });
    const response = await adapter.invoke({ model: "test", prompt: "Hello", mode: "safe" });
    expect(response.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 20,
      outputTokens: 50, reasoningTokens: 30, totalTokens: 150 });
    expect(adapter.estimateCost(response.usage)?.amountUsd).toBe(0.00019);
    expect(adapter.estimateCost(response.usage)?.status).toBe("estimated");
  });
});
