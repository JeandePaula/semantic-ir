import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { JsonOutputShape, ModelRequest } from "@semantic-ir/core";
import { BudgetLedger, DEFAULT_CODECS, JSON_EXTRACTION_SUITE, OpenAIAdapter, RuntimeRouter, SqliteStore,
  benchmarkCodec, modelOutputText, prepareJsonOutput, prepareResponseValidator, ResponseQualityError } from "./index.js";

const price = { version: "fixture", inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.15, outputUsdPerMillion: 0.5 };
const makeAdapter = (outputShape: JsonOutputShape = { type: "string" }) =>
  new OpenAIAdapter("fixture", { provider: "openrouter", apiKey: "fixture", price, outputShape });
const mockResponse = (text: string, finish_reason = "stop") => new Response(JSON.stringify({ model: "fixture",
  choices: [{ finish_reason, message: { content: text } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.000025,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
}), { status: 200 });

describe("native JSON output contracts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the paid wrong-shape response rejected and never guesses an extraction path", () => {
    const report = JSON.parse(readFileSync(new URL("../../../docs/experiments/openrouter-compression-2026-09-28/results.json", import.meta.url), "utf8")) as {
      results: Array<{ version: string; response: string }>;
    };
    const wrong = report.results.find(row => row.version === "compact")!.response;
    expect(prepareResponseValidator({ kind: "exact_json", expected: '"CORAL"' })(wrong).status).toBe("rejected");
    expect(prepareJsonOutput({ type: "string" }).decode(wrong).status).toBe("invalid");
    expect(prepareJsonOutput({ type: "string" }).decode('{"value":{"launch":{"color":"CORAL"}}}').reasons)
      .toEqual(["output_shape_mismatch"]);
  });

  it("sends a strict value envelope without leaking the oracle and retains the raw provider response", async () => {
    const fetchMock = vi.fn(async () => mockResponse('{"value":"PRIVATE_ORACLE"}'));
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      const result = await new RuntimeRouter(makeAdapter(), store).invoke("Extract answer from the supplied data.", {
        responseContract: { kind: "exact_json", expected: '"PRIVATE_ORACLE"' }, mode: "structured", maxOutputTokens: 128,
      });
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      const body = JSON.parse(String(init.body));
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "semantic_ir_response", strict: true,
        schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } });
      expect(body.provider).toEqual({ require_parameters: true, max_price: { prompt: 0.15, completion: 0.5 } });
      expect(body.messages[0].role).toBe("system");
      expect(String(init.body)).not.toContain("PRIVATE_ORACLE");
      expect(result.response.text).toBe('{"value":"PRIVATE_ORACLE"}');
      expect(result.outputText).toBe('"PRIVATE_ORACLE"');
      expect(result.structuredResult).toBe("PRIVATE_ORACLE");
      expect(result.quality.status).toBe("verified");
      expect(store.metricsSummary()).toMatchObject({ requests: 1, measuredCostUsd: 0.000025 });
    } finally { store.close(); }
  });

  it.each(['{"value":"WRONG"}', '{"value":{"color":"CORAL"}}', '{"value":"CORAL","extra":1}',
    '{"value":"CORAL","value":"CORAL"}', '```json\n{"value":"CORAL"}\n```', '"CORAL"'])(
    "rejects incorrect values or wire shapes without paid retries: %s", async text => {
    const fetchMock = vi.fn(async () => mockResponse(text));
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      await expect(new RuntimeRouter(makeAdapter(), store).invoke("Extract color", {
        responseContract: { kind: "exact_json", expected: '"CORAL"' },
      })).rejects.toBeInstanceOf(ResponseQualityError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.metricsSummary().measuredCostUsd).toBe(0.000025);
    } finally { store.close(); }
  });

  it("counts schema/instruction overhead in reservations and binds profiles to the output protocol", async () => {
    const ordinary = new OpenAIAdapter("fixture", { provider: "openrouter", apiKey: "fixture", price });
    const shaped = makeAdapter();
    const request: ModelRequest = { model: "fixture", prompt: "Extract color", mode: "safe", maxOutputTokens: 128 };
    const base = (await ordinary.preflight(request))!;
    const native = (await shaped.preflight(request))!;
    expect(native.upperInputTokens).toBeGreaterThan(base.upperInputTokens);
    expect(native.upperCostUsd).toBeGreaterThan(base.upperCostUsd);
    expect((await shaped.getModelFingerprint()).fingerprintSha256).not.toBe((await ordinary.getModelFingerprint()).fingerprintSha256);
    expect((await shaped.getModelFingerprint()).fingerprintSha256).not.toBe((await makeAdapter({ type: "integer" }).getModelFingerprint()).fingerprintSha256);
    const store = new SqliteStore(":memory:");
    try {
      store.promote(await ordinary.getModelFingerprint(), "extraction", DEFAULT_CODECS[1]!);
      expect((await new RuntimeRouter(shaped, store).decide("Extract the color  BLUE")).decision.fallbackReason)
        .toBe("model_fingerprint_changed");
    } finally { store.close(); }
  });

  it("validates local shape limits and contradictory references before spending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      await expect(new RuntimeRouter(makeAdapter(), store).invoke("Extract answer", {
        responseContract: { kind: "exact_json", expected: '{"color":"CORAL"}' },
      })).rejects.toThrow(/contradicts/);
      await expect(new RuntimeRouter(makeAdapter(), store).invoke("Extract answer", {
        responseContract: { kind: "exact_text", expected: "CORAL" },
      })).rejects.toThrow(/contradicts/);
      expect(() => new OpenAIAdapter("fixture", { outputShape: { type: "string" } })).toThrow(/require OpenRouter/);
      expect(() => prepareJsonOutput({ type: "string", enum: ["CORAL"] })).toThrow();
      expect(() => prepareJsonOutput({ type: "object", properties: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [i, { type: "string" }])) })).toThrow(/256/);
      const cycle: Record<string, unknown> = { type: "array" };
      cycle.items = cycle;
      expect(() => prepareJsonOutput(cycle)).toThrow(/levels/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("never silently retries without the schema if the provider rejects structured output", async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeAdapter().invoke({ model: "fixture", prompt: "Extract color", mode: "safe" })).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps shape-only content unverified and refuses incomplete or invalid envelopes without an oracle", async () => {
    const fetchMock = vi.fn(async () => mockResponse('{"value":"CORAL"}'));
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      const router = new RuntimeRouter(makeAdapter(), store);
      expect((await router.invoke("Extract color")).quality.status).toBe("unverified");
      fetchMock.mockImplementationOnce(async () => mockResponse('{"value":"CORAL"}', "length"));
      await expect(router.invoke("Extract color")).rejects.toBeInstanceOf(ResponseQualityError);
      fetchMock.mockImplementationOnce(async () => mockResponse('"CORAL"'));
      await expect(router.invoke("Extract color")).rejects.toBeInstanceOf(ResponseQualityError);
    } finally { store.close(); }
  });

  it("preserves nested typed values and rejects extra fields, wrong types and lossy numbers", () => {
    const output = prepareJsonOutput({ type: "object", properties: {
      ids: { type: "array", items: { type: "string" } }, count: { type: "integer" }, enabled: { type: "boolean" }, empty: { type: "null" },
    } });
    const value = { ids: ["900719925474099312", "東京"], count: 2, enabled: false, empty: null };
    expect(output.decode(JSON.stringify({ value })).outputText).toBe(JSON.stringify(value));
    expect(output.decode(JSON.stringify({ value: { ...value, count: "2" } })).status).toBe("invalid");
    expect(output.decode(JSON.stringify({ value: { ...value, extra: 0 } })).status).toBe("invalid");
    expect(prepareJsonOutput({ type: "number" }).decode('{"value":0.10000000000000001}').status).toBe("invalid");
    fc.assert(fc.property(fc.array(fc.string(), { maxLength: 20 }), values => {
      expect(prepareJsonOutput({ type: "array", items: { type: "string" } }).decode(JSON.stringify({ value: values })).outputText)
        .toBe(JSON.stringify(values));
    }), { numRuns: 100 });
  });

  it("benchmarks decoded answers while retaining usage and rejects incompatible oracles before calling", async () => {
    const fetchMock = vi.fn(async () => mockResponse('{"value":"BLUE"}'));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = makeAdapter();
    const suite = { ...JSON_EXTRACTION_SUITE, cases: [{ ...JSON_EXTRACTION_SUITE.cases[0]!, oracleId: "exact_json", expectedOutput: '"BLUE"' }] };
    const options = { adapter, suite, codec: DEFAULT_CODECS.find(codec => codec.id === "json_compact")!,
      split: "calibration" as const, taskClass: "extraction" as const, baselineCache: new Map(),
      ledger: new BudgetLedger({ maxRequests: 4, maxTokens: 100000, maxCostUsd: 0.1, maxDurationMs: 10000 }) };
    const [result] = await benchmarkCodec(options);
    expect(result?.evaluation.passedHardGates).toBe(true);
    expect(result?.candidate.outputTokens).toBe(20);
    expect(result?.candidate.costUsd).toBe(0.000025);
    suite.cases[0]!.expectedOutput = '{}';
    await expect(benchmarkCodec(options)).rejects.toThrow(/compatible/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const response = await adapter.invoke({ model: "fixture", prompt: "Extract answer", mode: "safe" });
    expect(modelOutputText(response)).toBe('"BLUE"');
  });
});
