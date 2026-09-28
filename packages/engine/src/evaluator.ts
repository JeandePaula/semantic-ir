import type { BenchmarkCase, EvaluationResult, ModelResponse, SemanticIR } from "@semantic-ir/core";
import type { CompiledPrompt } from "@semantic-ir/core";
import { validateCompiled } from "./codec.js";
import { prepareResponseValidator } from "./quality.js";

export function hasScorableOracle(testCase: BenchmarkCase): boolean {
  return testCase.expectedOutput !== undefined && ["exact", "exact_json"].includes(testCase.oracleId ?? "");
}

/** Validate JSON expectations before any paid call. Legacy exact oracles trim answers only. */
export function prepareCaseOracle(testCase: BenchmarkCase): (response: ModelResponse) => boolean {
  if (!hasScorableOracle(testCase)) return () => false;
  const verify = testCase.oracleId === "exact_json"
    ? prepareResponseValidator({ kind: "exact_json", expected: testCase.expectedOutput! }) : null;
  return response => response.completionStatus !== "incomplete" &&
    (verify ? verify(response.text).status === "verified" : response.text.trim() === testCase.expectedOutput);
}

/**
 * Deterministic evidence is intentionally limited to closed tasks with an
 * exact oracle. Open-ended quality requires a later task-specific evaluator.
 */
export function evaluateCase(
  testCase: BenchmarkCase,
  ir: SemanticIR,
  compiled: CompiledPrompt,
  baseline: ModelResponse,
  candidate: ModelResponse | null,
): EvaluationResult {
  const failures = validateCompiled(ir, compiled);
  for (const literal of testCase.expectedLiterals) {
    if (!ir.literals.some((item) => item.text.includes(literal)) ||
        !compiled.text.includes(literal)) failures.push("expected_literal_missing");
  }
  for (const marker of testCase.expectedConstraints) {
    if (!ir.constraints.some((item) => item.marker.toLowerCase() === marker.toLowerCase()) ||
        !compiled.text.toLowerCase().includes(marker.toLowerCase())) {
      failures.push("expected_constraint_missing");
    }
  }
  const literalPreservation = failures.some((value) => value.includes("literal_")) ? 0 : 1;
  const hardConstraintPreservation = failures.some((value) => value.includes("constraint_")) ? 0 : 1;
  const hasOracle = hasScorableOracle(testCase);
  const verify = prepareCaseOracle(testCase);
  const baselineSuccess = verify(baseline);
  const candidateSuccess = candidate !== null && verify(candidate);
  const behaviorSame = candidate !== null && (testCase.oracleId === "exact_json"
    ? baselineSuccess && candidateSuccess : baseline.text.trim() === candidate.text.trim());
  const passedHardGates = failures.length === 0 && baselineSuccess && candidateSuccess && behaviorSame;
  return {
    caseId: testCase.id,
    codecVersion: compiled.codecId + "@" + compiled.codecVersion,
    schemaValid: true,
    literalPreservation,
    hardConstraintPreservation,
    negationPreservation: hardConstraintPreservation,
    semanticFidelity: hasOracle ? (passedHardGates ? 1 : 0) : null,
    taskSuccess: hasOracle && candidate ? candidateSuccess : null,
    qualityRatioToBaseline: baselineSuccess ? (candidateSuccess ? 1 : 0) : null,
    behavioralEquivalence: candidate ? (behaviorSame ? 1 : 0) : null,
    passedHardGates,
    evidenceStatus: hasOracle ? "measured" : "unavailable",
    reasons: [
      ...failures,
      ...(hasOracle ? [] : ["no_exact_oracle"]),
      ...(baselineSuccess ? [] : ["baseline_failed_or_unverified"]),
      ...(candidate === null ? ["candidate_skipped_baseline_failed"] : candidateSuccess ? [] : ["candidate_failed_or_unverified"]),
      ...(candidate && !behaviorSame ? ["behavior_changed"] : []),
    ],
  };
}
