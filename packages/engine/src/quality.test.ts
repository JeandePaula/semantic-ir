import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseStrictJson, prepareResponseValidator, prepareResponseProcessor } from "./quality.js";
import { RuntimeRouter, ResponseQualityError } from "./runtime.js";
import { OpenAIAdapter } from "./openai.js";
import { SqliteStore } from "./storage.js";

describe("answer contracts", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("unwraps only an explicitly allowed single JSON fence and still validates every value", () => {
    const process = prepareResponseProcessor({ kind: "exact_json", expected: '{"a":1}', normalization: "single_json_fence" });
    expect(process('```json\n{"a":1}\n```')).toMatchObject({ outputText: '{"a":1}',
      normalization: "single_json_fence", quality: { status: "verified" } });
    for (const text of ['before\n```json\n{"a":1}\n```', '```json\n{"a":1}\n```\nafter',
      '```json\n{"a":2}\n```', '```json\n{"a":1,"a":1}\n```', '```json\n{}\n```\n```json\n{"a":1}\n```']) {
      expect(process(text).quality.status).toBe("rejected");
    }
    expect(prepareResponseValidator({ kind: "exact_json", expected: '{"a":1}' })('```json\n{"a":1}\n```').status).toBe("rejected");
  });
  it("returns normalized verified output while preserving raw provider evidence", async () => {
    const raw = '```json\n{"answer":1}\n```';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: "test",
      choices: [{ finish_reason: "stop", message: { content: raw } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      const router = new RuntimeRouter(new OpenAIAdapter("test", { provider: "openrouter", apiKey: "fixture" }), store);
      const result = await router.invoke("Extract answer", { mode: "structured", responseContract: {
        kind: "exact_json", expected: '{"answer":1}', normalization: "single_json_fence",
      } });
      expect(result.response.text).toBe(raw);
      expect(result.outputText).toBe('{"answer":1}');
      expect(result.structuredResult).toEqual({ answer: 1 });
      expect(result.quality.status).toBe("verified");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });
  it("accepts JSON layout/key changes but rejects changed types, values, extra keys and array order", () => {
    const verify = prepareResponseValidator({ kind: "exact_json", expected: '{"a":[1,2],"b":true}' });
    expect(verify('{ "b": true, "a": [1, 2] }').status).toBe("verified");
    for (const text of ['{"a":[2,1],"b":true}', '{"a":["1",2],"b":true}',
      '{"a":[1,2],"b":false}', '{"a":[1,2],"b":true,"c":0}', '{"a":[1,2]']) {
      expect(verify(text).status).toBe("rejected");
    }
  });
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":9007199254740993}',
    '{"a":9007199254740990.1}', '1e999', '1e-999', '0.10000000000000001', '[1,]', '{"a":1,}',
    '{"a":1} trailing', '```json\n{}\n```'])('refuses ambiguous or lossy JSON: %s', text => {
    expect(() => parseStrictJson(text)).toThrow();
  });
  it("accepts equivalent precise numeric spellings and string escapes", () => {
    const verify = prepareResponseValidator({ kind: "exact_json", expected: JSON.stringify({ a: 1000, b: 0.25, s: 'a"b' }) });
    expect(verify('{"a":1e3,"b":0.2500,"s":"a\\u0022b"}').status).toBe("verified");
    expect(prepareResponseValidator({ kind: "exact_text", expected: "GREEN" })("GREEN\n").status).toBe("rejected");
    expect(prepareResponseValidator()("probably correct").status).toBe("unverified");
  });
  it("rejects all four historical complex responses against the frozen oracle", () => {
    const dir = new URL("../../../docs/experiments/complex-json/", import.meta.url);
    const verify = prepareResponseValidator({ kind: "exact_json", expected: readFileSync(new URL("expected.json", dir), "utf8") });
    for (const file of ["normal-1.json", "normal-2.txt", "compact-1.json", "compact-2.json"]) {
      expect(verify(readFileSync(new URL(file, dir), "utf8")).status).toBe("rejected");
    }
  });
  it.each([
    ["stop", '{"answer":2}'], ["length", '{"answer":1}'], ["stop", null],
  ])("records rejected provider cost and never retries: %s / %s", async (finish_reason, content) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: "test",
      choices: [{ finish_reason, message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      const router = new RuntimeRouter(new OpenAIAdapter("test", { provider: "openrouter", apiKey: "fixture" }), store);
      await expect(router.invoke("Extract answer", { responseContract: { kind: "exact_json", expected: '{"answer":1}' } }))
        .rejects.toBeInstanceOf(ResponseQualityError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.metricsSummary()).toMatchObject({ requests: 1, measuredCostUsd: 0.001 });
    } finally { store.close(); }
  });
  it("validates contracts before spending, and explicitly labels responses with no contract", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: "test", status: "completed",
      output: [{ content: [{ type: "output_text", text: "OK" }] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new SqliteStore(":memory:");
    try {
      const router = new RuntimeRouter(new OpenAIAdapter("test", { apiKey: "fixture" }), store);
      await expect(router.invoke("Extract answer", { responseContract: { kind: "exact_json", expected: "bad JSON" } })).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await router.invoke("Extract answer")).quality.status).toBe("unverified");
      expect((await router.invoke("Extract answer", { responseContract: { kind: "exact_text", expected: "OK" } })).quality.status).toBe("verified");
    } finally { store.close(); }
  });
});
