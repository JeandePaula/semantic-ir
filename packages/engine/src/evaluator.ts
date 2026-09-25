import type { BenchmarkCase, EvaluationResult, ModelResponse, SemanticIR } from "@semantic-ir/core";
import type { CompiledPrompt } from "@semantic-ir/core";
import { validateCompiled } from "./codec.js";

/**
 * Deterministic evidence is intentionally limited to closed tasks with an
 * exact oracle. Open-ended quality requires a later task-specific evaluator.
 */
export function evaluateCase(
  testCase: BenchmarkCase,
  ir: SemanticIR,
  compiled: CompiledPrompt,
  baseline: ModelResponse,
  candidate: ModelResponse,
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
  const oracle = testCase.expectedOutput;
  const hasOracle = oracle !== undefined;
  const baselineSuccess = hasOracle && baseline.text.trim() === oracle;
  const candidateSuccess = hasOracle && candidate.text.trim() === oracle;
  const behaviorSame = baseline.text.trim() === candidate.text.trim();
  const passedHardGates = failures.length === 0 && baselineSuccess && candidateSuccess && behaviorSame;
  return {
    caseId: testCase.id,
    codecVersion: compiled.codecId + "@" + compiled.codecVersion,
    schemaValid: true,
    literalPreservation,
    hardConstraintPreservation,
    negationPreservation: hardConstraintPreservation,
    semanticFidelity: hasOracle ? (passedHardGates ? 1 : 0) : null,
    taskSuccess: hasOracle ? candidateSuccess : null,
    qualityRatioToBaseline: baselineSuccess ? (candidateSuccess ? 1 : 0) : null,
    behavioralEquivalence: behaviorSame ? 1 : 0,
    passedHardGates,
    evidenceStatus: hasOracle ? "measured" : "unavailable",
    reasons: [
      ...failures,
      ...(hasOracle ? [] : ["no_exact_oracle"]),
      ...(baselineSuccess ? [] : ["baseline_failed_or_unverified"]),
      ...(candidateSuccess ? [] : ["candidate_failed_or_unverified"]),
      ...(behaviorSame ? [] : ["behavior_changed"]),
    ],
  };
}
