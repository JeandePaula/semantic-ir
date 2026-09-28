import type { ModelResponse, UsageMetrics } from "@semantic-ir/core";
import type { OpenAIPrice } from "./openai.js";

const count = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;

/** Price attribution, not a replacement for the provider's measured bill. Reasoning is part of output. */
export function attributeCost(usage: UsageMetrics, price: OpenAIPrice) {
  if (![price.inputUsdPerMillion, price.cachedInputUsdPerMillion, price.outputUsdPerMillion]
    .every(value => Number.isFinite(value) && value >= 0)) throw new Error("Invalid token price");
  const cached = count(usage.cachedInputTokens) ? usage.cachedInputTokens : null;
  const inputUsd = !count(usage.inputTokens) || (cached !== null && cached > usage.inputTokens) ? null :
    cached !== null ? ((usage.inputTokens - cached) * price.inputUsdPerMillion + cached * price.cachedInputUsdPerMillion) / 1e6 :
      price.inputUsdPerMillion === price.cachedInputUsdPerMillion ? usage.inputTokens * price.inputUsdPerMillion / 1e6 : null;
  const outputUsd = count(usage.outputTokens) ? usage.outputTokens * price.outputUsdPerMillion / 1e6 : null;
  return { inputUsd, outputUsd, totalUsd: inputUsd !== null && outputUsd !== null ? inputUsd + outputUsd : null };
}

export function compareResponseCosts(baseline: ModelResponse, candidate: ModelResponse, price: OpenAIPrice) {
  const original = attributeCost(baseline.usage, price);
  const compiled = attributeCost(candidate.usage, price);
  const delta = (a: number | null, b: number | null) => a !== null && b !== null ? b - a : null;
  const measured = (response: ModelResponse) => response.cost?.status === "measured" &&
    response.cost.amountUsd !== null && Number.isFinite(response.cost.amountUsd) && response.cost.amountUsd >= 0
    ? response.cost.amountUsd : null;
  const inputDeltaUsd = delta(original.inputUsd, compiled.inputUsd);
  const outputDeltaUsd = delta(original.outputUsd, compiled.outputUsd);
  const extraOutputTokensAtBreakEven = inputDeltaUsd !== null && price.outputUsdPerMillion > 0
    ? -inputDeltaUsd * 1e6 / price.outputUsdPerMillion : null;
  const measuredDeltaUsd = delta(measured(baseline), measured(candidate));
  const pricedDeltaUsd = delta(original.totalUsd, compiled.totalUsd);
  return { priceVersion: price.version, baseline: original, candidate: compiled,
    inputDeltaUsd, outputDeltaUsd, pricedDeltaUsd, measuredDeltaUsd,
    unexplainedDeltaUsd: delta(pricedDeltaUsd, measuredDeltaUsd),
    extraOutputTokens: count(baseline.usage.outputTokens) && count(candidate.usage.outputTokens)
      ? candidate.usage.outputTokens - baseline.usage.outputTokens : null,
    extraReasoningTokens: count(baseline.usage.reasoningTokens) && count(candidate.usage.reasoningTokens)
      ? candidate.usage.reasoningTokens - baseline.usage.reasoningTokens : null,
    extraOutputTokensAtBreakEven,
    note: "Reasoning is included in output tokens; never add it again. Break-even assumes these prices and observed cache usage, not future behavior.",
  };
}
