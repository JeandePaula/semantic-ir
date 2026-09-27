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

/** Realistic structured payloads, with different values and shapes in each split. */
export const JSON_EXTRACTION_SUITE: BenchmarkSuite = {
  id: "json-extraction", version: "0.1.0",
  cases: (["calibration", "validation", "holdout"] as const).flatMap((split, index) =>
    [0, 1].map((variant) => {
      const color = ["BLUE", "GREEN", "AMBER", "CYAN", "ORANGE", "VIOLET"][index * 2 + variant]!;
      const records = Array.from({ length: 12 + index * 3 + variant }, (_, row) => ({
        id: row, label: "Item " + row, active: row % 2 === 0, tags: ["stock", "approved"],
      }));
      return {
        id: "json-" + split + "-" + variant, version: "0.1", split, taskClass: "extraction" as const,
        prompt: "Extract the launch.color value from the JSON. Reply with the value only.\n" +
          "```json\n" + JSON.stringify({ records, launch: { color } }, null, 4) + "\n```",
        expectedLiterals: [color], expectedConstraints: ["only"], oracleId: "exact", expectedOutput: color,
      };
    })),
};

export class BudgetLedger {
  usedRequests = 0;
  usedTokens = 0;
  usedCostUsd = 0;
  measuredCostUsd: number | null = null;
  budgetMethod: "provider_count" | "conservative_byte_envelope" = "provider_count";
  reservedTokens = 0;
  reservedCostUsd = 0;
  private unmeasuredCalls = 0;
  get completeMeasuredCostUsd(): number | null {
    return this.unmeasuredCalls === 0 ? this.measuredCostUsd : null;
  }
  private readonly startedAt = Date.now();

  constructor(readonly budget: CalibrationBudget) {
    if (Object.values(budget).some((value) => !Number.isFinite(value) || value <= 0) ||
        !Number.isSafeInteger(budget.maxRequests) || !Number.isSafeInteger(budget.maxTokens)) {
      throw new Error("Invalid calibration budget");
    }
  }

  async invoke(adapter: ModelAdapter, request: ModelRequest): Promise<ModelResponse> {
    if (!Number.isSafeInteger(request.maxOutputTokens) || (request.maxOutputTokens ?? 0) <= 0) {
      throw new Error("Calibration requires a positive output token limit");
    }
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
    if (![upperInputTokens, upperCostUsd].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error("Invalid budget preflight");
    }
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
    this.reservedTokens += upperTokens;
    this.reservedCostUsd += upperCostUsd;
    this.unmeasuredCalls++;
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
        this.reservedTokens += upperTokens;
        this.reservedCostUsd += upperCostUsd;
        this.unmeasuredCalls++;
        retries++;
      }
    }
    // Reconcile a successful call before enforcing overruns. Unknown/failed calls keep their reserve.
    const usage = response.usage;
    const validCount = (value: number | null): value is number =>
      value !== null && Number.isSafeInteger(value) && value >= 0;
    const actualTokens = validCount(usage.inputTokens) && validCount(usage.outputTokens)
      ? Math.max(usage.inputTokens + usage.outputTokens, validCount(usage.totalTokens) ? usage.totalTokens : 0)
      : null;
    if (actualTokens !== null) this.usedTokens += actualTokens - upperTokens;
    let actualCost: number | null = null;
    if (response.cost?.status === "measured" && response.cost.amountUsd !== null) {
      actualCost = response.cost.amountUsd;
      if (!Number.isFinite(actualCost) || actualCost < 0) throw new Error("Invalid provider cost");
      this.measuredCostUsd = (this.measuredCostUsd ?? 0) + actualCost;
      this.unmeasuredCalls--;
    } else if (!preflight) {
      actualCost = adapter.estimateCost?.(usage)?.amountUsd ?? null;
    }
    if (actualCost !== null && Number.isFinite(actualCost) && actualCost >= 0) {
      this.usedCostUsd += actualCost - upperCostUsd;
    }
    if (validCount(usage.inputTokens) && usage.inputTokens > upperInputTokens) {
      throw new Error("Provider input usage exceeded preflight reservation");
    }
    if (actualTokens !== null && actualTokens > upperTokens) {
      throw new Error("Provider token usage exceeded preflight reservation");
    }
    if (actualCost !== null && actualCost > upperCostUsd + 1e-9) {
      throw new Error("Provider cost exceeded preflight reservation");
    }
    return response;
  }
}

export interface CaseResult {
  readonly caseId: string;
  readonly split: BenchmarkCase["split"];
  readonly evaluation: EvaluationResult;
  readonly baseline: { inputTokens: number | null; outputTokens: number | null; latencyMs: number;
    cachedInputTokens?: number | null; reasoningTokens?: number | null;
    costUsd: number | null; costEvidence: "measured" | "estimated" | "unavailable" };
  readonly candidate: { inputTokens: number | null; outputTokens: number | null; latencyMs: number;
    cachedInputTokens?: number | null; reasoningTokens?: number | null;
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
  stopOnFailure?: boolean;
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
        disableResponseCache: true,
      });
      options.baselineCache.set(testCase.id, baseline);
    }
    const candidate = compiled.text === testCase.prompt ? baseline : await options.ledger.invoke(options.adapter, {
      model: (await options.adapter.getModelFingerprint()).model,
      prompt: compiled.text, mode: "safe", maxOutputTokens, scope: "application_request",
      disableResponseCache: true,
    });
    const evaluation = evaluateCase(testCase, ir, compiled, baseline, candidate);
    const costFor = (response: ModelResponse) => {
      if (response.cost?.status === "measured" && response.cost.amountUsd !== null &&
          Number.isFinite(response.cost.amountUsd) && response.cost.amountUsd >= 0) {
        return { costUsd: response.cost.amountUsd, costEvidence: "measured" as const };
      }
      if (options.adapter.getCapabilities().tokenCounting) {
        const estimate = options.adapter.estimateCost?.(response.usage);
        if (estimate?.amountUsd !== null && estimate?.amountUsd !== undefined &&
            Number.isFinite(estimate.amountUsd) && estimate.amountUsd >= 0) {
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
        cachedInputTokens: baseline.usage.cachedInputTokens, reasoningTokens: baseline.usage.reasoningTokens,
        latencyMs: baseline.latencyMs, ...baseCost,
      },
      candidate: {
        inputTokens: candidate.usage.inputTokens,
        outputTokens: candidate.usage.outputTokens,
        cachedInputTokens: candidate.usage.cachedInputTokens, reasoningTokens: candidate.usage.reasoningTokens,
        latencyMs: candidate.latencyMs, ...candidateCost,
      },
    });
    if (options.stopOnFailure && (!evaluation.passedHardGates || baseCost.costUsd === null ||
        candidateCost.costUsd === null || candidateCost.costUsd >= baseCost.costUsd * 0.99)) break;
  }
  return results;
}
