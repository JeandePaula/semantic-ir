import type {
  BenchmarkCase, BenchmarkSuite, CalibrationBudget, CodecDefinition,
  EvaluationResult, ModelAdapter, ModelRequest, ModelResponse, TaskClass,
} from "@semantic-ir/core";
import { analyzePrompt } from "@semantic-ir/core";
import { compilePrompt } from "./codec.js";
import { evaluateCase } from "./evaluator.js";

const unscoredCases: BenchmarkCase[] = [
  ["instruction_following", "reasoning", "Follow these instructions in order: greet, then count."],
  ["negation", "reasoning", "Never disclose the private value 7500."],
  ["hard_constraints", "coding", "Implement this function but preserve its public API."],
  ["coding", "coding", "Implement a function that adds two integers."],
  ["debugging", "debugging", "Debug the failing parser without changing its API."],
  ["security_review", "code_review", "Security review this authentication flow."],
  ["reasoning", "reasoning", "Compare two possible plans and explain tradeoffs."],
  ["math", "math", "Calculate 17 times 23."],
  ["summarization", "summarization", "Summarize a long article in two sentences."],
  ["multilingual", "multilingual", "Responda em português sobre este tópico."],
  ["translation", "translation", "Translate this sentence to Spanish."],
  ["long_context", "long_context", "Find a fact in this long context reference."],
  ["tool_use", "tool_use", "Use the tool to query a database."],
  ["structured_output", "structured_output", "Output in JSON with a key named status."],
  ["ambiguous_prompts", "conversation", "Make it better."],
  ["literal_preservation", "extraction", "Extract https://example.com/a exactly."],
  ["creative_tasks", "creative_writing", "Write a short poem about clouds."],
  ["conversational_nuance", "conversation", "Reply empathetically to a disappointed customer."],
].map(([category, taskClass, prompt], index) => ({
  id: "probe-" + index, version: "0.1", category: category ?? "unknown",
  split: "calibration" as const, taskClass: taskClass as TaskClass,
  prompt: prompt ?? "", expectedLiterals: [], expectedConstraints: [], oracleId: null,
}));

export const SYNTHETIC_SUITE: BenchmarkSuite = {
  id: "synthetic-exact",
  version: "0.1.0",
  cases: [
    { id: "c1", version: "0.1", split: "calibration", taskClass: "extraction",
      prompt: "Return only the value BLUE.  Do not add punctuation.",
      expectedLiterals: [], expectedConstraints: ["only", "Do not"],
      oracleId: "exact", expectedOutput: "BLUE" },
    { id: "c2", version: "0.1", split: "calibration", taskClass: "extraction",
      prompt: "Extract the number 8500.  Reply with digits only.",
      expectedLiterals: ["8500"], expectedConstraints: ["only"],
      oracleId: "exact", expectedOutput: "8500" },
    { id: "v1", version: "0.1", split: "validation", taskClass: "extraction",
      prompt: "Return only GREEN.  Never include a period.",
      expectedLiterals: [], expectedConstraints: ["only", "Never"],
      oracleId: "exact", expectedOutput: "GREEN" },
    { id: "h1", version: "0.1", split: "holdout", taskClass: "extraction",
      prompt: "Return only the number 42.  No explanation.",
      expectedLiterals: ["42"], expectedConstraints: ["only", "No"],
      oracleId: "exact", expectedOutput: "42" },
    ...unscoredCases,
  ],
};

export class BudgetLedger {
  usedRequests = 0;
  usedTokens = 0;
  usedCostUsd = 0;
  private readonly startedAt = Date.now();

  constructor(readonly budget: CalibrationBudget) {}

  async invoke(adapter: ModelAdapter, request: ModelRequest): Promise<ModelResponse> {
    if (!adapter.countTokens || !adapter.estimateCost) {
      throw new Error("Strict calibration requires token counting and a configured price");
    }
    if (this.usedRequests + 2 > this.budget.maxRequests) throw new Error("Request budget exhausted");
    if (Date.now() - this.startedAt >= this.budget.maxDurationMs) throw new Error("Duration budget exhausted");
    const remainingBeforeCount = this.budget.maxDurationMs - (Date.now() - this.startedAt);
    this.usedRequests++;
    const count = await adapter.countTokens({ ...request, timeoutMs: remainingBeforeCount });
    if (!count) throw new Error("Token counting unavailable; calibration stopped");
    const upperTokens = count.inputTokens + (request.maxOutputTokens ?? 0);
    const upperCost = adapter.estimateCost({
      inputTokens: count.inputTokens, cachedInputTokens: 0,
      outputTokens: request.maxOutputTokens ?? 0, reasoningTokens: null,
      totalTokens: upperTokens, source: count.source,
    });
    if (upperCost?.amountUsd === null || upperCost?.amountUsd === undefined) {
      throw new Error("Cost rate unavailable; calibration stopped");
    }
    if (this.usedTokens + upperTokens > this.budget.maxTokens) throw new Error("Token budget exhausted");
    if (this.usedCostUsd + upperCost.amountUsd > this.budget.maxCostUsd) {
      throw new Error("Cost budget exhausted");
    }
    const remainingBeforeInvoke = this.budget.maxDurationMs - (Date.now() - this.startedAt);
    if (remainingBeforeInvoke <= 0) throw new Error("Duration budget exhausted");
    this.usedRequests++;
    // Reserve the upper bound before the network call. A failure still consumes budget.
    this.usedTokens += upperTokens;
    this.usedCostUsd += upperCost.amountUsd;
    const response = await adapter.invoke({ ...request, timeoutMs: remainingBeforeInvoke });
    if (response.usage.inputTokens !== null && response.usage.inputTokens > count.inputTokens) {
      throw new Error("Provider input usage exceeded count endpoint result");
    }
    return response;
  }
}

export interface CaseResult {
  readonly caseId: string;
  readonly split: BenchmarkCase["split"];
  readonly evaluation: EvaluationResult;
  readonly baseline: { inputTokens: number | null; outputTokens: number | null; latencyMs: number; costUsd: number | null };
  readonly candidate: { inputTokens: number | null; outputTokens: number | null; latencyMs: number; costUsd: number | null };
}

export async function benchmarkCodec(options: {
  adapter: ModelAdapter;
  codec: CodecDefinition;
  suite: BenchmarkSuite;
  split: BenchmarkCase["split"];
  taskClass: TaskClass;
  ledger: BudgetLedger;
  baselineCache: Map<string, ModelResponse>;
  maxOutputTokens?: number;
}): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const testCase of options.suite.cases.filter(
    (item) => item.split === options.split && item.taskClass === options.taskClass &&
      item.oracleId === "exact" && item.expectedOutput !== undefined)) {
    const ir = analyzePrompt(testCase.prompt);
    const compiled = compilePrompt(ir, options.codec);
    let baseline = options.baselineCache.get(testCase.id);
    const maxOutputTokens = options.maxOutputTokens ?? 64;
    if (!baseline) {
      baseline = await options.ledger.invoke(options.adapter, {
        model: (await options.adapter.getModelFingerprint()).model,
        prompt: testCase.prompt, mode: "safe", maxOutputTokens, scope: "application_request",
      });
      options.baselineCache.set(testCase.id, baseline);
    }
    const candidate = await options.ledger.invoke(options.adapter, {
      model: (await options.adapter.getModelFingerprint()).model,
      prompt: compiled.text, mode: "safe", maxOutputTokens, scope: "application_request",
    });
    const evaluation = evaluateCase(testCase, ir, compiled, baseline, candidate);
    const baseCost = options.adapter.estimateCost?.(baseline.usage)?.amountUsd ?? null;
    const candidateCost = options.adapter.estimateCost?.(candidate.usage)?.amountUsd ?? null;
    results.push({
      caseId: testCase.id, split: testCase.split, evaluation,
      baseline: {
        inputTokens: baseline.usage.inputTokens,
        outputTokens: baseline.usage.outputTokens,
        latencyMs: baseline.latencyMs, costUsd: baseCost,
      },
      candidate: {
        inputTokens: candidate.usage.inputTokens,
        outputTokens: candidate.usage.outputTokens,
        latencyMs: candidate.latencyMs, costUsd: candidateCost,
      },
    });
  }
  return results;
}
