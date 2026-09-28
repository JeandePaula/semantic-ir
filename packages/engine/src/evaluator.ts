import type { BenchmarkCase, EvaluationResult, JsonOutputShape, ModelResponse, SemanticIR } from "@semantic-ir/core";
import type { CompiledPrompt } from "@semantic-ir/core";
import { validateCompiled } from "./codec.js";
import { parseStrictJson, prepareResponseValidator } from "./quality.js";
import { matchesOutputShape, modelOutputText } from "./output.js";

export function validateCaseOutputShape(testCase: BenchmarkCase, shape?: JsonOutputShape | null): void {
  if (!shape) return;
  if (testCase.oracleId !== "exact_json" || testCase.expectedOutput === undefined ||
      !matchesOutputShape(parseStrictJson(testCase.expectedOutput), shape)) {
    throw new Error("Native output shape requires compatible exact_json oracles: " + testCase.id);
  }
}

export function hasScorableOracle(testCase: BenchmarkCase): boolean {
  return testCase.expectedOutput !== undefined && ["exact", "exact_json"].includes(testCase.oracleId ?? "");
}

/** Validate JSON expectations before any paid call. Legacy exact oracles trim answers only. */
export function prepareCaseOracle(testCase: BenchmarkCase): (response: ModelResponse) => boolean {
  if (!hasScorableOracle(testCase)) return () => false;
  const verify = testCase.oracleId === "exact_json"
    ? prepareResponseValidator({ kind: "exact_json", expected: testCase.expectedOutput! }) : null;
  return response => {
    const text = modelOutputText(response);
    return response.completionStatus !== "incomplete" && text !== null &&
      (verify ? verify(text).status === "verified" : text.trim() === testCase.expectedOutput);
  };
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
    ? baselineSuccess && candidateSuccess : modelOutputText(baseline) !== null &&
      modelOutputText(baseline)?.trim() === modelOutputText(candidate)?.trim());
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
