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

function repeatedContextCase(id: string, split: BenchmarkCase["split"], color: string): BenchmarkCase {
  const fact = `The launch label color is ${color} and the same label is used in every approved view.`;
  return {
    id, version: "0.2", split, taskClass: "extraction",
    prompt: "Extract the launch label color from CONTEXT. Reply with the uppercase color word and no other text.\n" +
      "CONTEXT:\n" + Array(32).fill(fact).join("\n") +
      "\nQUESTION:\nWhat is the launch label color?",
    expectedLiterals: [], expectedConstraints: ["no"],
    oracleId: "exact", expectedOutput: color,
  };
}

/** Closed, paid evaluation cases. Savings here never imply savings on other workloads. */
export const REDUNDANT_EXTRACTION_SUITE: BenchmarkSuite = {
  id: "redundant-extraction", version: "0.2.0",
  cases: [
    repeatedContextCase("rc-blue", "calibration", "BLUE"),
    repeatedContextCase("rc-green", "calibration", "GREEN"),
    repeatedContextCase("rv-amber", "validation", "AMBER"),
    repeatedContextCase("rv-cyan", "validation", "CYAN"),
    repeatedContextCase("rh-orange", "holdout", "ORANGE"),
    repeatedContextCase("rh-violet", "holdout", "VIOLET"),
  ],
};

export class BudgetLedger {
  usedRequests = 0;
  usedTokens = 0;
  usedCostUsd = 0;
  measuredCostUsd: number | null = null;
  budgetMethod: "provider_count" | "conservative_byte_envelope" = "provider_count";
  private readonly startedAt = Date.now();

  constructor(readonly budget: CalibrationBudget) {}

  async invoke(adapter: ModelAdapter, request: ModelRequest): Promise<ModelResponse> {
    const preflight = await adapter.preflight?.(request);
    const requestSlots = preflight ? 1 : 2;
    if (this.usedRequests + requestSlots > this.budget.maxRequests) {
      throw new Error("Request budget exhausted");
    }
    if (Date.now() - this.startedAt >= this.budget.maxDurationMs) throw new Error("Duration budget exhausted");
    let upperInputTokens: number;
    let upperCostUsd: number;
    if (preflight) {
      this.budgetMethod = preflight.method;
      upperInputTokens = preflight.upperInputTokens;
      upperCostUsd = preflight.upperCostUsd;
    } else {
      if (!adapter.countTokens || !adapter.estimateCost) {
        throw new Error("Calibration requires token preflight and a configured price");
      }
      const remainingBeforeCount = this.budget.maxDurationMs - (Date.now() - this.startedAt);
      this.usedRequests++;
      const count = await adapter.countTokens({ ...request, timeoutMs: remainingBeforeCount });
      if (!count) throw new Error("Token counting unavailable; calibration stopped");
      upperInputTokens = count.inputTokens;
      const upperCost = adapter.estimateCost({
        inputTokens: count.inputTokens, cachedInputTokens: 0,
        outputTokens: request.maxOutputTokens ?? 0, reasoningTokens: null,
        totalTokens: count.inputTokens + (request.maxOutputTokens ?? 0), source: count.source,
      });
      if (upperCost?.amountUsd === null || upperCost?.amountUsd === undefined) {
        throw new Error("Cost rate unavailable; calibration stopped");
      }
      upperCostUsd = upperCost.amountUsd;
    }
    const upperTokens = upperInputTokens + (request.maxOutputTokens ?? 0);
    if (this.usedTokens + upperTokens > this.budget.maxTokens) throw new Error("Token budget exhausted");
    if (this.usedCostUsd + upperCostUsd > this.budget.maxCostUsd) {
      throw new Error("Cost budget exhausted");
    }
    const remainingBeforeInvoke = this.budget.maxDurationMs - (Date.now() - this.startedAt);
    if (remainingBeforeInvoke <= 0) throw new Error("Duration budget exhausted");
    this.usedRequests++;
    // Reserve the upper bound before the network call. A failure still consumes budget.
    this.usedTokens += upperTokens;
    this.usedCostUsd += upperCostUsd;
    let response: ModelResponse;
    let retries = 0;
    while (true) {
      try {
        const remainingMs = this.budget.maxDurationMs - (Date.now() - this.startedAt);
        if (remainingMs <= 0) throw new Error("Duration budget exhausted");
        response = await adapter.invoke({
          ...request, timeoutMs: remainingMs,
        });
        break;
      } catch (error) {
        const rateLimit = error as Error & { status?: number; retryAfterMs?: number | null };
        if (rateLimit.status !== 429 || retries >= 3) throw error;
        const delayMs = Math.min(60_000, Math.max(1_000,
          rateLimit.retryAfterMs ?? 10_000 * 2 ** retries));
        if (this.usedRequests + 1 > this.budget.maxRequests) throw new Error("Request budget exhausted");
        if (this.usedTokens + upperTokens > this.budget.maxTokens) throw new Error("Token budget exhausted");
        if (this.usedCostUsd + upperCostUsd > this.budget.maxCostUsd) {
          throw new Error("Cost budget exhausted");
        }
        if (this.budget.maxDurationMs - (Date.now() - this.startedAt) <= delayMs) {
          throw new Error("Duration budget exhausted");
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        this.usedRequests++;
        this.usedTokens += upperTokens;
        this.usedCostUsd += upperCostUsd;
        retries++;
      }
    }
    if (response.usage.inputTokens !== null && response.usage.inputTokens > upperInputTokens) {
      throw new Error("Provider input usage exceeded preflight reservation");
    }
    if (response.cost?.status === "measured" && response.cost.amountUsd !== null) {
      this.measuredCostUsd = (this.measuredCostUsd ?? 0) + response.cost.amountUsd;
      if (preflight && response.cost.amountUsd > upperCostUsd + 1e-9) {
        throw new Error("Provider cost exceeded conservative preflight reservation");
      }
    }
    return response;
  }
}

export interface CaseResult {
  readonly caseId: string;
  readonly split: BenchmarkCase["split"];
  readonly evaluation: EvaluationResult;
  readonly baseline: { inputTokens: number | null; outputTokens: number | null; latencyMs: number;
    costUsd: number | null; costEvidence: "measured" | "estimated" | "unavailable" };
  readonly candidate: { inputTokens: number | null; outputTokens: number | null; latencyMs: number;
    costUsd: number | null; costEvidence: "measured" | "estimated" | "unavailable" };
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
    const costFor = (response: ModelResponse) => {
      if (response.cost?.status === "measured" && response.cost.amountUsd !== null) {
        return { costUsd: response.cost.amountUsd, costEvidence: "measured" as const };
      }
      if (options.adapter.getCapabilities().tokenCounting) {
        const estimate = options.adapter.estimateCost?.(response.usage);
        if (estimate?.amountUsd !== null && estimate?.amountUsd !== undefined) {
          return { costUsd: estimate.amountUsd, costEvidence: "estimated" as const };
        }
      }
      return { costUsd: null, costEvidence: "unavailable" as const };
    };
    const baseCost = costFor(baseline);
    const candidateCost = costFor(candidate);
    results.push({
      caseId: testCase.id, split: testCase.split, evaluation,
      baseline: {
        inputTokens: baseline.usage.inputTokens,
        outputTokens: baseline.usage.outputTokens,
        latencyMs: baseline.latencyMs, ...baseCost,
      },
      candidate: {
        inputTokens: candidate.usage.inputTokens,
        outputTokens: candidate.usage.outputTokens,
        latencyMs: candidate.latencyMs, ...candidateCost,
      },
    });
  }
  return results;
}
