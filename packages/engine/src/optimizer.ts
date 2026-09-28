import { randomUUID } from "node:crypto";
import { analyzePrompt, sha256 } from "@semantic-ir/core";
import type {
  CodecCandidate, CodecDefinition, CodecVersion, ModelAdapter,
  ModelResponse, OptimizationInput, OptimizationRun, Optimizer,
} from "@semantic-ir/core";
import { benchmarkCodec, BudgetLedger, type CaseResult } from "./benchmark.js";
import { compilePrompt } from "./codec.js";
import { MINIMUM_SAVINGS_BYTES } from "./audit.js";
import type { SqliteStore } from "./storage.js";
import { hasScorableOracle, prepareCaseOracle, validateCaseOutputShape } from "./evaluator.js";

function codecVersion(definition: CodecDefinition): CodecVersion {
  return {
    id: definition.id, version: "0.1.0", definition,
    definitionSha256: sha256(JSON.stringify(definition)), status: "experimental", parentVersion: null,
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
  // Network jitter must not reject an otherwise cheaper, correct candidate.
  return candidate === 0 ? Number.MAX_VALUE : base / candidate;
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
  readonly screenedCandidates?: readonly { codecId: string; reason: string; savedBytes: number }[];
  readonly economics?: {
    calibrationCostUsd: number;
    costBasis: "measured" | "accounted_upper_bound";
    averageSavingsPerRequestUsd: number | null;
    breakEvenRequests: number | null;
    assumption: string;
  };
  readonly reservations?: { tokens: number; costUsd: number };
  readonly diagnostics?: readonly string[];
}

/** Also works on older persisted reports, without inventing reasoning or cache usage. */
export function diagnoseReport(report: OptimizationReport): string[] {
  const results = [...report.calibration, ...report.validation, ...report.holdout];
  const reasons = new Set<string>();
  if (!results.length) reasons.add("no_paid_evaluation_results");
  for (const item of results) {
    if (item.candidateSkipped) reasons.add("candidate_skipped_baseline_failed");
    if (!item.evaluation.passedHardGates) reasons.add("task_or_preservation_gate_failed");
    if (item.baseline.costUsd === null || item.candidate.costUsd === null) reasons.add("cost_unavailable");
    if (item.candidate.inputTokens !== null && item.baseline.inputTokens !== null &&
        item.candidate.inputTokens < item.baseline.inputTokens &&
        item.candidate.outputTokens !== null && item.baseline.outputTokens !== null &&
        item.candidate.outputTokens > item.baseline.outputTokens) {
      reasons.add("output_tokens_grew_after_input_compression");
    }
    if (item.candidate.costUsd !== null && item.baseline.costUsd !== null &&
        item.candidate.costUsd >= item.baseline.costUsd * 0.99) reasons.add("insufficient_total_cost_reduction");
    if ((item.baseline.cachedInputTokens ?? 0) > 0) reasons.add("baseline_benefited_from_prompt_cache");
    if ((item.candidate.reasoningTokens ?? 0) > 0) reasons.add("reasoning_contributes_to_output_cost");
  }
  if (!report.holdoutEvidence) reasons.add("no_confirmed_holdout_savings");
  return [...reasons];
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
      hasScorableOracle(item));
    const screenedCandidates: { codecId: string; reason: string; savedBytes: number }[] = [];
    const signatures = new Set<string>();
    const seeds = input.seeds.map((seed) => seed.definition).filter((codec) => {
      try {
        const texts = scoredCalibration.map((item) => compilePrompt(analyzePrompt(item.prompt), codec).text);
        const reductions = texts.map((text, index) => Buffer.byteLength(scoredCalibration[index]!.prompt) -
          Buffer.byteLength(text));
        const signature = sha256(JSON.stringify(texts));
        const minimum = input.minimumSavingsBytes ?? MINIMUM_SAVINGS_BYTES;
        const reason = !reductions.length || reductions.some((value) => value <= 0) ? "no_size_reduction" :
          reductions.some((value) => value < minimum) ? "reduction_too_small" :
            signatures.has(signature) ? "duplicate_candidate" : null;
        if (reason) {
          screenedCandidates.push({ codecId: codec.id, reason,
            savedBytes: reductions.reduce((sum, value) => sum + value, 0) });
          return false;
        }
        signatures.add(signature);
        return true;
      } catch {
        screenedCandidates.push({ codecId: codec.id, reason: "semantic_verification_failed", savedBytes: 0 });
        return false;
      }
    });
    const calibration = new Map<string, CaseResult[]>();
    const validation = new Map<string, CaseResult[]>();
    const holdout: CaseResult[] = [];
    const candidates: CodecCandidate[] = [];
    let selected: CodecDefinition | null = null;
    let selectionReason = "no_candidate_passed_all_gates_with_measured_improvement";
    let status: OptimizationRun["status"] = "completed";

    try {
      const scored = input.suite.cases.filter((item) => item.taskClass === input.taskClass &&
        hasScorableOracle(item));
      for (const item of scored) {
        prepareCaseOracle(item);
        validateCaseOutputShape(item, this.adapter.outputShape);
      }
      if (new Set(scored.map((item) => item.id)).size !== scored.length ||
          new Set(scored.map((item) => item.prompt)).size !== scored.length) {
        throw new Error("Scored cases require distinct ids and prompts across splits");
      }
      for (const split of ["calibration", "validation", "holdout"] as const) {
        if (!input.suite.cases.some((item) => item.split === split &&
            item.taskClass === input.taskClass && hasScorableOracle(item))) {
          throw new Error("No scored " + split + " cases for task class " + input.taskClass);
        }
      }
      if (!seeds.length) selectionReason = "no_candidate_with_material_size_reduction";
      for (const codec of seeds) {
        const results = await benchmarkCodec({
          adapter: this.adapter, codec, suite: input.suite, split: "calibration",
          taskClass: input.taskClass, ledger, baselineCache,
          stopOnFailure: true,
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
          stopOnFailure: true,
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
          stopOnFailure: true,
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
      screenedCandidates,
      reservations: { tokens: ledger.reservedTokens, costUsd: ledger.reservedCostUsd },
      economics: {
        calibrationCostUsd: ledger.completeMeasuredCostUsd ?? ledger.usedCostUsd,
        costBasis: ledger.completeMeasuredCostUsd !== null ? "measured" : "accounted_upper_bound",
        averageSavingsPerRequestUsd: selected && evidenceAvailable
          ? (baselineHoldoutCost - candidateHoldoutCost) / holdout.length : null,
        breakEvenRequests: selected && evidenceAvailable && baselineHoldoutCost > candidateHoldoutCost
          ? Math.ceil((ledger.completeMeasuredCostUsd ?? ledger.usedCostUsd) /
            ((baselineHoldoutCost - candidateHoldoutCost) / holdout.length)) : null,
        assumption: "Projection assumes future requests match the holdout costs; production savings are unverified.",
      },
    };
    this.lastReport = { ...this.lastReport, diagnostics: diagnoseReport(this.lastReport) };
    return run;
  }
}
