import { randomUUID } from "node:crypto";
import { analyzePrompt } from "@semantic-ir/core";
import type {
  CodecCandidate, CodecDefinition, CodecVersion, ModelAdapter,
  ModelResponse, OptimizationInput, OptimizationRun, Optimizer,
} from "@semantic-ir/core";
import { benchmarkCodec, BudgetLedger, type CaseResult } from "./benchmark.js";
import { compilePrompt, mutateElite } from "./codec.js";
import type { SqliteStore } from "./storage.js";

function codecVersion(definition: CodecDefinition): CodecVersion {
  return {
    id: definition.id, version: "0.1.0", definition,
    definitionSha256: "", status: "experimental", parentVersion: null,
  };
}

function fitness(results: readonly CaseResult[]): number | null {
  if (!results.length || results.some((item) => !item.evaluation.passedHardGates)) return null;
  const base = results.reduce((sum, item) => sum + (item.baseline.costUsd ?? 0), 0);
  const candidate = results.reduce((sum, item) => sum + (item.candidate.costUsd ?? 0), 0);
  if (results.some((item) => item.baseline.costUsd === null || item.candidate.costUsd === null) || base <= 0) {
    return null;
  }
  if (results.some((item) => (item.candidate.costUsd ?? Infinity) >=
      (item.baseline.costUsd ?? 0) * 0.99)) return null;
  if (candidate >= base * 0.99) return null;
  const costRatio = candidate / base;
  const baseLatency = results.reduce((sum, item) => sum + item.baseline.latencyMs, 0);
  const candidateLatency = results.reduce((sum, item) => sum + item.candidate.latencyMs, 0);
  const latencyRatio = baseLatency > 0 ? candidateLatency / baseLatency : 1;
  // Quality and hard gates have already passed. Cost dominates, latency breaks ties.
  return (1 / costRatio) * (1 / Math.max(0.5, latencyRatio)) ** 0.1;
}

export interface OptimizationReport {
  readonly run: OptimizationRun;
  readonly promoted?: boolean;
  readonly selectedCodecId: string | null;
  readonly selectionReason: string;
  readonly calibration: readonly CaseResult[];
  readonly validation: readonly CaseResult[];
  readonly holdout: readonly CaseResult[];
  readonly costStatus: "provider_measured" | "estimated_from_usage" | "unavailable";
  readonly holdoutEvidence: {
    cases: number; baselineCostUsd: number; candidateCostUsd: number;
    savingsPercent: number; costEvidence: "measured" | "estimated";
  } | null;
}

export class EvolutionaryOptimizer implements Optimizer {
  lastReport: OptimizationReport | null = null;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly store: SqliteStore,
  ) {}

  async optimize(input: OptimizationInput): Promise<OptimizationRun> {
    const startedAt = new Date().toISOString();
    const ledger = new BudgetLedger(input.budget);
    const baselineCache = new Map<string, ModelResponse>();
    const scoredCalibration = input.suite.cases.filter((item) =>
      item.split === "calibration" && item.taskClass === input.taskClass &&
      item.oracleId === "exact" && item.expectedOutput !== undefined);
    const changesEveryCase = (codec: CodecDefinition): boolean => scoredCalibration.length > 0 &&
      scoredCalibration.every((item) => {
        try { return compilePrompt(analyzePrompt(item.prompt), codec).text !== item.prompt; }
        catch { return false; }
      });
    const seeds = input.seeds.map((seed) => seed.definition).filter(changesEveryCase);
    const calibration = new Map<string, CaseResult[]>();
    const validation = new Map<string, CaseResult[]>();
    const holdout: CaseResult[] = [];
    const candidates: CodecCandidate[] = [];
    let selected: CodecDefinition | null = null;
    let selectionReason = "no_candidate_passed_all_gates_with_measured_improvement";
    let status: OptimizationRun["status"] = "completed";

    try {
      for (const split of ["calibration", "validation", "holdout"] as const) {
        if (!input.suite.cases.some((item) => item.split === split &&
            item.taskClass === input.taskClass && item.oracleId === "exact" &&
            item.expectedOutput !== undefined)) {
          throw new Error("No scored " + split + " cases for task class " + input.taskClass);
        }
      }
      for (const codec of seeds) {
        const results = await benchmarkCodec({
          adapter: this.adapter, codec, suite: input.suite, split: "calibration",
          taskClass: input.taskClass, ledger, baselineCache,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
        });
        calibration.set(codec.id, results);
        candidates.push({ codec: codecVersion(codec), fitness: fitness(results),
          evaluations: results.map((item) => item.evaluation) });
      }
      const firstElite = candidates.filter((item) => item.fitness !== null)
        .sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))
        .slice(0, 2);
      for (const codec of mutateElite(firstElite.map((item) => item.codec.definition)).filter(changesEveryCase)) {
        const results = await benchmarkCodec({
          adapter: this.adapter, codec, suite: input.suite, split: "calibration",
          taskClass: input.taskClass, ledger, baselineCache,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
        });
        calibration.set(codec.id, results);
        candidates.push({ codec: codecVersion(codec), fitness: fitness(results),
          evaluations: results.map((item) => item.evaluation) });
      }
      const elite = candidates.filter((item) => item.fitness !== null)
        .sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))
        .slice(0, 2);
      for (const candidate of elite) {
        const results = await benchmarkCodec({
          adapter: this.adapter, codec: candidate.codec.definition,
          suite: input.suite, split: "validation", taskClass: input.taskClass,
          ledger, baselineCache,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
        });
        validation.set(candidate.codec.id, results);
      }
      const validated = elite
        .map((item) => ({
          definition: item.codec.definition,
          score: fitness([...(calibration.get(item.codec.id) ?? []),
            ...(validation.get(item.codec.id) ?? [])]),
        }))
        .filter((item) => item.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const winner = validated[0];
      if (winner && winner.score !== null && winner.score > 1) {
        const results = await benchmarkCodec({
          adapter: this.adapter, codec: winner.definition,
          suite: input.suite, split: "holdout", taskClass: input.taskClass,
          ledger, baselineCache,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
        });
        holdout.push(...results);
        const holdoutScore = fitness(results);
        const currentFingerprint = await this.adapter.getModelFingerprint();
        if (currentFingerprint.fingerprintSha256 !== input.fingerprint.fingerprintSha256) {
          selectionReason = "model_fingerprint_changed";
        } else if (holdoutScore !== null && holdoutScore > 1) {
          selected = winner.definition;
          selectionReason = "passed_calibration_validation_holdout";
          this.store.promote(input.fingerprint, input.taskClass, selected);
        } else {
          selectionReason = "holdout_did_not_confirm_improvement";
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      status = /budget/i.test(message) ? "budget_exhausted" : "failed";
      selectionReason = message;
    }

    const run: OptimizationRun = {
      id: randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      fingerprintSha256: input.fingerprint.fingerprintSha256,
      taskClass: input.taskClass, candidates,
      usedRequests: ledger.usedRequests, usedTokens: ledger.usedTokens,
      usedCostUsd: ledger.usedCostUsd, measuredCostUsd: ledger.measuredCostUsd,
      budgetMethod: ledger.budgetMethod, status,
    };
    const allResults = [...calibration.values()].flat().concat(
      ...[...validation.values()], holdout);
    const evidenceAvailable = holdout.length > 0 && holdout.every((item) =>
      item.evaluation.passedHardGates && item.baseline.costUsd !== null &&
      item.candidate.costUsd !== null);
    const baselineHoldoutCost = holdout.reduce((sum, item) => sum + (item.baseline.costUsd ?? 0), 0);
    const candidateHoldoutCost = holdout.reduce((sum, item) => sum + (item.candidate.costUsd ?? 0), 0);
    const allMeasured = allResults.length > 0 && allResults.every((item) =>
      item.baseline.costEvidence === "measured" && item.candidate.costEvidence === "measured");
    this.lastReport = {
      run, selectedCodecId: selected?.id ?? null, selectionReason,
      calibration: [...calibration.values()].flat(),
      validation: [...validation.values()].flat(), holdout,
      costStatus: allMeasured ? "provider_measured" :
        allResults.length > 0 && allResults.every((item) =>
          item.baseline.costUsd !== null && item.candidate.costUsd !== null)
          ? "estimated_from_usage" : "unavailable",
      holdoutEvidence: selected && evidenceAvailable && baselineHoldoutCost > 0 ? {
        cases: holdout.length, baselineCostUsd: baselineHoldoutCost,
        candidateCostUsd: candidateHoldoutCost,
        savingsPercent: 100 * (1 - candidateHoldoutCost / baselineHoldoutCost),
        costEvidence: allMeasured ? "measured" : "estimated",
      } : null,
    };
    return run;
  }
}
