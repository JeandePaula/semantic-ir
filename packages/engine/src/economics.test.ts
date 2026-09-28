import { describe, expect, it } from "vitest";
import type { ModelResponse, UsageMetrics } from "@semantic-ir/core";
import { attributeCost, compareResponseCosts } from "./economics.js";

const price = { version: "fixture", inputUsdPerMillion: 0.045, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0.14 };
const usage = (inputTokens: number, outputTokens: number, reasoningTokens: number): UsageMetrics => ({
  inputTokens, outputTokens, reasoningTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens, source: "provider_usage",
});

describe("cost attribution", () => {
  it("explains the captured complex pair without double counting reasoning", () => {
    const response = (u: UsageMetrics, cost: number) => ({ usage: u, cost: { status: "measured", amountUsd: cost } }) as ModelResponse;
    const result = compareResponseCosts(response(usage(4248, 6444, 3418), 0.00109332),
      response(usage(2886, 7259, 3798), 0.00114613), price);
    expect(result.inputDeltaUsd).toBeCloseTo(-0.00006129, 12);
    expect(result.outputDeltaUsd).toBeCloseTo(0.0001141, 12);
    expect(result.measuredDeltaUsd).toBeCloseTo(0.00005281, 12);
    expect(result.unexplainedDeltaUsd).toBeCloseTo(0, 12);
    expect(result.extraOutputTokens).toBe(815);
    expect(result.extraReasoningTokens).toBe(380);
    expect(result.extraOutputTokensAtBreakEven).toBeCloseTo(437.785714, 5);
  });
  it("accounts for cache discounts and leaves unavailable prices/counts unknown", () => {
    expect(attributeCost({ ...usage(100, 10, 5), cachedInputTokens: 100 }, price).inputUsd).toBe(0);
    expect(attributeCost({ ...usage(100, 10, 5), cachedInputTokens: null }, price).totalUsd).toBeNull();
    expect(attributeCost({ ...usage(100, 10, 5), cachedInputTokens: 101 }, price).inputUsd).toBeNull();
    expect(attributeCost({ ...usage(100, 10, 5), outputTokens: null }, price).outputUsd).toBeNull();
    expect(() => attributeCost(usage(1, 1, 0), { ...price, outputUsdPerMillion: -1 })).toThrow();
  });
});
