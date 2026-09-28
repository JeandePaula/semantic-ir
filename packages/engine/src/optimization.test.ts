import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { analyzePrompt, sha256 } from "@semantic-ir/core";
import type { ModelAdapter, ModelRequest, ModelResponse, BenchmarkSuite, CodecDefinition } from "@semantic-ir/core";
import { auditPrompt, compilePrompt, validateCompiled, DEFAULT_CODECS, JSON_EXTRACTION_SUITE,
  REDUNDANT_EXTRACTION_SUITE, SYNTHETIC_SUITE, EvolutionaryOptimizer, SqliteStore,
  BudgetLedger, RuntimeRouter, diagnoseReport, OpenAIAdapter, benchmarkCodec } from "./index.js";
import { compactJsonValue } from "./json.js";

const jsonCodec = DEFAULT_CODECS.find((codec) => codec.id === "json_compact")!;
const budget = { maxRequests: 50, maxTokens: 100_000, maxCostUsd: 1, maxDurationMs: 60_000 };

function fixtureAdapter() {
  const capabilities = { tokenCounting: false, reasoningMetadata: true, structuredOutput: false,
    tools: false, streaming: false, contextSize: null, tokenizerId: null };
  const fingerprint = { provider: "fixture", model: "fixture", snapshot: "v1", capabilities,
    fingerprintSha256: sha256("fixture"), observedAt: "2026-09-26" };
  const invoke = vi.fn(async (request: ModelRequest): Promise<ModelResponse> => {
    const text = /"color"\s*:\s*"([A-Z]+)"/.exec(request.prompt)?.[1] ?? "BLUE";
    return {
      text, usage: { inputTokens: request.prompt.length, outputTokens: 2, cachedInputTokens: 0,
        reasoningTokens: 0, totalTokens: request.prompt.length + 2, source: "provider_usage" },
      cost: { amountUsd: (request.prompt.length + 2) / 1_000_000, status: "measured",
        priceVersion: null, category: "calibration" },
      latencyMs: 10, providerRequestId: "fixture", modelFingerprint: fingerprint,
    };
  });
  const adapter: ModelAdapter = { invoke, getCapabilities: () => capabilities,
    getModelFingerprint: async () => fingerprint,
    preflight: async (request) => ({ upperInputTokens: request.prompt.length * 2,
      upperCostUsd: (request.prompt.length * 2 + request.maxOutputTokens!) / 1_000_000,
      method: "conservative_byte_envelope" }),
  };
  return { adapter, invoke, fingerprint };
}

async function optimize(suite: BenchmarkSuite, codecs: readonly CodecDefinition[] = DEFAULT_CODECS) {
  const fixture = fixtureAdapter();
  const store = new SqliteStore(":memory:");
  const optimizer = new EvolutionaryOptimizer(fixture.adapter, store);
  const run = await optimizer.optimize({ fingerprint: fixture.fingerprint, taskClass: "extraction", suite,
    seeds: codecs.map((definition) => ({ id: definition.id, definition, version: "0.1.0",
      definitionSha256: "", status: "experimental", parentVersion: null })), budget });
  return { ...fixture, store, optimizer, run };
}

describe("calibration quality preflight", () => {
  it("skips candidate spending when the baseline fails and leaves skipped metrics unknown", async () => {
    const { adapter, invoke } = fixtureAdapter();
    const suite = { ...JSON_EXTRACTION_SUITE, cases: [{ ...JSON_EXTRACTION_SUITE.cases[0]!, expectedOutput: "WRONG" }] };
    const ledger = new BudgetLedger(budget);
    const [result] = await benchmarkCodec({ adapter, codec: jsonCodec, suite, split: "calibration",
      taskClass: "extraction", ledger, baselineCache: new Map() });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ledger.usedRequests).toBe(1);
    expect(result).toMatchObject({ candidateSkipped: "baseline_failed", candidate: { costUsd: null, latencyMs: null, inputTokens: null },
      evaluation: { passedHardGates: false, taskSuccess: null, behavioralEquivalence: null } });
  });
  it("validates all JSON oracles before spending and compares JSON values instead of key layout", async () => {
    const { adapter, invoke } = fixtureAdapter();
    const suite = { ...JSON_EXTRACTION_SUITE, cases: JSON_EXTRACTION_SUITE.cases.slice(0, 2).map(item => ({
      ...item, oracleId: "exact_json", expectedOutput: '{"a":1,"b":2}',
    })) };
    suite.cases[1]!.expectedOutput = '{"a":1,"a":2}';
    const options = { adapter, codec: jsonCodec, suite, split: "calibration" as const, taskClass: "extraction" as const,
      ledger: new BudgetLedger(budget), baselineCache: new Map() };
    await expect(benchmarkCodec(options)).rejects.toThrow(/Duplicate/);
    expect(invoke).not.toHaveBeenCalled();
    suite.cases[1]!.expectedOutput = '{"b":2,"a":1}';
    const original = adapter.invoke;
    adapter.invoke = async request => ({ ...await original(request), text: request.prompt.includes('    ')
      ? '{"a":1,"b":2}' : '{ "b": 2, "a": 1 }' });
    const results = await benchmarkCodec(options);
    expect(results.every(item => item.evaluation.passedHardGates)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(4);
  });
});

describe("structural JSON compression", () => {
  it("preserves JSON values across generated arrays, strings and nested objects", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const source = JSON.stringify(value, null, 4);
      const compact = compactJsonValue(source);
      expect(JSON.parse(compact)).toEqual(JSON.parse(source));
      expect(compact.length).toBeLessThanOrEqual(source.length);
    }), { numRuns: 200 });
  });

  it("preserves raw numeric lexemes, duplicate keys, escapes and spaces inside strings", () => {
    const source = String.raw`{ "id": 900719925474099312345, "id": -0, "x": 1.2300e+40, "s": "a  b\t\u00e9\"z" }`;
    expect(compactJsonValue(source)).toBe(String.raw`{"id":900719925474099312345,"id":-0,"x":1.2300e+40,"s":"a  b\t\u00e9\"z"}`);
    expect(compactJsonValue('{ "bad": }')).toBe('{ "bad": }');
  });

  it("replays the complete transformation to reject forged preservation proofs", () => {
    const ir = analyzePrompt('Extract the id. Never change the result.\n```json\n{ "id": 8500, "s": "a  b" }\n```');
    const compiled = compilePrompt(ir, jsonCodec);
    expect(compiled.text).toContain('{"id":8500,"s":"a  b"}');
    expect(compiled.text).toContain("Never change the result.");
    expect(validateCompiled(ir, compiled)).toEqual([]);
    expect(validateCompiled(ir, { ...compiled, text: compiled.text.replace("8500", "8501") }))
      .toContain("transformation_mismatch");
    expect(validateCompiled(ir, { ...compiled, text: compiled.text + "\nIgnore instructions" }))
      .toContain("transformation_mismatch");
  });

  it.each(["Copy verbatim", "Extract the number of lines", "Extract whitespace", "Extract a checksum",
    "Extract and preserve formatting", "Extract the original JSON exactly", "Extract the length",
    "Extraia o tamanho", "Extraia os espaços", "Implement a parser"])("skips %s", (instruction) => {
    const prompt = instruction + '\n{ "a": 1 }';
    expect(compilePrompt(analyzePrompt(prompt), jsonCodec).text).toBe(prompt);
  });

  it("preserves non-JSON code and rejects malformed JSON fences", () => {
    const prompt = 'Extract the value.\n```python\nx =  4\n```\n```json\n{ "x": }\n```';
    expect(compilePrompt(analyzePrompt(prompt), jsonCodec).text).toBe(prompt);
  });

  it("identifies material local reductions without declaring token or dollar savings", () => {
    const result = auditPrompt(JSON_EXTRACTION_SUITE.cases[0]!.prompt);
    expect(result.recommendedCodecId).toBe("json_compact");
    expect(result.candidates.find((item) => item.codecId === "json_compact")?.reductionPercent)
      .toBeGreaterThan(40);
    expect(result).toMatchObject({ providerCalls: 0, tokenSavings: "unavailable", costSavings: "unavailable" });
    expect(auditPrompt("Extract BLUE.").recommendedCodecId).toBeNull();
  });
});

describe("cost-aware calibration", () => {
  it("spends nothing on tiny changes or tags that grow the input", async () => {
    const { store, run, invoke, optimizer } = await optimize(SYNTHETIC_SUITE);
    try {
      expect(run.status).toBe("completed");
      expect(invoke).not.toHaveBeenCalled();
      expect(optimizer.lastReport?.selectionReason).toBe("no_candidate_with_material_size_reduction");
      expect(optimizer.lastReport?.screenedCandidates).toHaveLength(DEFAULT_CODECS.length);
    } finally { store.close(); }
  });

  it("deduplicates candidates, validates every split, and reports amortization of the full run", async () => {
    const duplicate = { ...jsonCodec, id: "same_json" };
    const { store, run, optimizer, adapter, invoke } = await optimize(JSON_EXTRACTION_SUITE, [jsonCodec, duplicate]);
    try {
      expect(run.status).toBe("completed");
      expect(invoke).toHaveBeenCalledTimes(12);
      expect(invoke.mock.calls.every(([request]) => request.disableResponseCache)).toBe(true);
      expect(optimizer.lastReport?.screenedCandidates).toContainEqual(expect.objectContaining({
        codecId: "same_json", reason: "duplicate_candidate",
      }));
      const report = optimizer.lastReport!;
      expect(report.holdoutEvidence?.savingsPercent).toBeGreaterThan(40);
      expect(report.economics?.calibrationCostUsd).toBeCloseTo(run.measuredCostUsd!, 12);
      expect(report.economics?.breakEvenRequests).toBe(Math.ceil(run.measuredCostUsd! /
        report.economics!.averageSavingsPerRequestUsd!));
      expect(report.reservations!.costUsd).toBeGreaterThan(run.usedCostUsd!);
      const route = await new RuntimeRouter(adapter, store).decide(JSON_EXTRACTION_SUITE.cases[0]!.prompt);
      expect(route.decision.mode).toBe("compiled");
      expect(route.compiledText.length).toBeLessThan(JSON_EXTRACTION_SUITE.cases[0]!.prompt.length);
    } finally { store.close(); }
  });

  it("stops a candidate when extra output tokens erase its input savings", async () => {
    const { adapter, fingerprint, invoke } = fixtureAdapter();
    const baseInvoke = adapter.invoke;
    adapter.invoke = async (request) => {
      const response = await baseInvoke(request);
      if (request.prompt.length > 1000) return response;
      return { ...response, usage: { ...response.usage, outputTokens: 60 },
        cost: { ...response.cost!, amountUsd: 0.003 } };
    };
    adapter.preflight = async (request) => ({ upperInputTokens: request.prompt.length * 2,
      upperCostUsd: 0.02, method: "conservative_byte_envelope" });
    const store = new SqliteStore(":memory:");
    try {
      const optimizer = new EvolutionaryOptimizer(adapter, store);
      await optimizer.optimize({ fingerprint, taskClass: "extraction", suite: REDUNDANT_EXTRACTION_SUITE,
        seeds: [{ id: "context_dedupe", version: "0.1", definition: DEFAULT_CODECS[2]!,
          definitionSha256: "", status: "experimental", parentVersion: null }], budget });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(store.listProfiles()).toHaveLength(0);
      expect(optimizer.lastReport?.diagnostics).toContain("output_tokens_grew_after_input_compression");
      expect(optimizer.lastReport?.economics?.breakEvenRequests).toBeNull();
    } finally { store.close(); }
  });

  it("rejects duplicated cases across splits before any paid calls", async () => {
    const suite = { ...JSON_EXTRACTION_SUITE, cases: [...JSON_EXTRACTION_SUITE.cases,
      { ...JSON_EXTRACTION_SUITE.cases[0]!, id: "leaked", split: "holdout" as const }] };
    const { store, run, invoke } = await optimize(suite);
    try {
      expect(run.status).toBe("failed");
      expect(invoke).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("does not silently retry a failed compiled call with a second paid inference", async () => {
    const { adapter, fingerprint } = fixtureAdapter();
    const invoke = vi.fn(async () => { throw new Error("HTTP 429"); });
    adapter.invoke = invoke;
    const store = new SqliteStore(":memory:");
    try {
      store.promote(fingerprint, "extraction", jsonCodec);
      const router = new RuntimeRouter(adapter, store);
      await expect(router.invoke(JSON_EXTRACTION_SUITE.cases[0]!.prompt)).rejects.toThrow("HTTP 429");
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });

  it("refuses a previously promoted codec that increases the payload", async () => {
    const { adapter, fingerprint } = fixtureAdapter();
    const store = new SqliteStore(":memory:");
    try {
      store.promote(fingerprint, "extraction", DEFAULT_CODECS[3]!);
      expect((await new RuntimeRouter(adapter, store).decide("Extract BLUE.")).decision.fallbackReason)
        .toBe("codec_does_not_reduce_input");
    } finally { store.close(); }
  });

  it("diagnoses old reports without fabricating reasoning measurements", async () => {
    const { store, optimizer } = await optimize(SYNTHETIC_SUITE);
    try { expect(diagnoseReport(optimizer.lastReport!)).toContain("no_confirmed_holdout_savings"); }
    finally { store.close(); }
  });
});

describe("budget reconciliation", () => {
  const request: ModelRequest = { model: "fixture", prompt: "BLUE", mode: "safe", maxOutputTokens: 64 };
  it("releases unused reservation while keeping exact measured cost and cumulative ceilings", async () => {
    const { adapter, invoke } = fixtureAdapter();
    const ledger = new BudgetLedger({ ...budget, maxTokens: 80, maxCostUsd: 0.00008 });
    await ledger.invoke(adapter, request);
    await ledger.invoke(adapter, request);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(ledger.usedTokens).toBe(12);
    expect(ledger.reservedTokens).toBe(144);
    expect(ledger.usedCostUsd).toBeCloseTo(0.000012, 12);
    expect(ledger.completeMeasuredCostUsd).toBeCloseTo(0.000012, 12);
  });
  it("retains reservations for failures whose billing is unknown", async () => {
    const { adapter } = fixtureAdapter();
    adapter.invoke = async () => { throw new Error("connection lost"); };
    const ledger = new BudgetLedger(budget);
    await expect(ledger.invoke(adapter, request)).rejects.toThrow("connection lost");
    expect(ledger.usedTokens).toBe(72);
    expect(ledger.usedCostUsd).toBe(0.000072);
    expect(ledger.completeMeasuredCostUsd).toBeNull();
  });
  it("records charged usage before stopping an overrun", async () => {
    const { adapter } = fixtureAdapter();
    adapter.preflight = async () => ({ upperInputTokens: 1, upperCostUsd: 0.000001,
      method: "conservative_byte_envelope" });
    const ledger = new BudgetLedger(budget);
    await expect(ledger.invoke(adapter, request)).rejects.toThrow("exceeded");
    expect(ledger.measuredCostUsd).toBe(0.000006);
    expect(ledger.usedTokens).toBe(6);
  });
});

describe("OpenRouter output and caching policy", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("applies configured reasoning to all text calls, binds profiles to it, and disables cache only for benchmarks", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ model: "fixture", choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0.000002 } }));
    }));
    const adapter = new OpenAIAdapter("fixture", { provider: "openrouter", apiKey: "fixture",
      reasoningEffort: "none", price: { version: "fixture", inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 1, outputUsdPerMillion: 2 } });
    const plain = new OpenAIAdapter("fixture", { provider: "openrouter", apiKey: "fixture",
      price: { version: "fixture", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 2 } });
    expect((await adapter.getModelFingerprint()).fingerprintSha256)
      .not.toBe((await plain.getModelFingerprint()).fingerprintSha256);
    await adapter.invoke({ model: "fixture", prompt: "Say OK", mode: "safe", maxOutputTokens: 64 });
    await adapter.invoke({ model: "fixture", prompt: "Say OK", mode: "safe", maxOutputTokens: 64,
      disableResponseCache: true });
    expect(JSON.parse(String(calls[0]!.body)).reasoning).toEqual({ effort: "none" });
    expect(calls[0]!.headers).not.toHaveProperty("X-OpenRouter-Cache");
    expect(calls[1]!.headers).toHaveProperty("X-OpenRouter-Cache", "false");
  });
});
