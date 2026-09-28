import { randomUUID } from "node:crypto";
import { analyzePrompt } from "@semantic-ir/core";
import type {
  ModelAdapter, ModelRequest, ModelResponse, OptimizationScope,
  OutputMode, RuntimeDecision, SemanticIR,
} from "@semantic-ir/core";
import { compilePrompt } from "./codec.js";
import type { SqliteStore } from "./storage.js";
import { prepareResponseProcessor, type QualityResult, type ResponseContract } from "./quality.js";

export interface RoutedResponse {
  readonly response: ModelResponse;
  /** Validated presentation; response.text preserves the provider's original evidence. */
  readonly outputText: string;
  readonly normalization: "single_json_fence" | null;
  readonly decision: RuntimeDecision;
  readonly semanticResult: SemanticIR | null;
  readonly structuredResult: unknown | null;
  readonly quality: QualityResult;
}

/** A rejected answer is not returned as a successful response. Charges remain recorded. */
export class ResponseQualityError extends Error {
  constructor(readonly quality: QualityResult, readonly usage: ModelResponse["usage"],
    readonly cost: ModelResponse["cost"] | null, readonly decision: RuntimeDecision) {
    super("Response rejected: " + quality.reasons.join(", "));
    this.name = "ResponseQualityError";
  }
}

export function classifyRisk(ir: SemanticIR): RuntimeDecision["risk"] {
  const text = ir.source.text;
  if (ir.intent.task === "unknown") return "high";
  if (/\b(?:contract|legal advice|lawyer|tax|bank transfer|wire funds|contrato|jurídic|imposto)\b/i.test(text)) {
    return "high";
  }
  if (ir.constraints.length > 3 || text.length > 20_000) return "high";
  const literalLength = ir.literals.reduce((total, item) => total +
    (item.kind === "json" && ["extraction", "structured_output"].includes(ir.intent.task) ? 0 : item.text.length), 0);
  if (literalLength / text.length > 0.5) return "high";
  if (ir.constraints.length || literalLength) return "medium";
  return "low";
}

export class RuntimeRouter {
  constructor(private readonly adapter: ModelAdapter, private readonly store: SqliteStore) {}

  async decide(prompt: string): Promise<{ decision: RuntimeDecision; compiledText: string }> {
    const ir = analyzePrompt(prompt);
    const fingerprint = await this.adapter.getModelFingerprint();
    const risk = classifyRisk(ir);
    const base: RuntimeDecision = {
      mode: "original", codecVersion: null, fallbackReason: null,
      taskClass: ir.intent.task, risk, fingerprintSha256: fingerprint.fingerprintSha256,
    };
    const fallback = (reason: string) => ({ decision: { ...base, fallbackReason: reason }, compiledText: prompt });
    if (risk === "high") return fallback("high_risk_or_low_classification_confidence");
    const profile = this.store.getProfile(fingerprint.provider, fingerprint.model, ir.intent.task);
    if (!profile) return fallback("no_stable_profile");
    if (profile.fingerprintSha256 !== fingerprint.fingerprintSha256) {
      return fallback("model_fingerprint_changed");
    }
    if (profile.status !== "stable") return fallback("profile_needs_reverification");
    const codec = this.store.getCodec(profile.codecId);
    if (!codec) return fallback("codec_missing");
    try {
      const compiled = compilePrompt(ir, codec);
      if (compiled.text === prompt) return fallback("codec_no_change");
      if (Buffer.byteLength(compiled.text) >= Buffer.byteLength(prompt)) return fallback("codec_does_not_reduce_input");
      return {
        decision: {
          ...base, mode: "compiled", codecVersion: compiled.codecId + "@" + compiled.codecVersion,
        },
        compiledText: compiled.text,
      };
    } catch {
      return fallback("semantic_verification_failed");
    }
  }

  async invoke(prompt: string, options: {
    mode?: OutputMode;
    scope?: OptimizationScope;
    maxOutputTokens?: number;
    responseContract?: ResponseContract;
  } = {}): Promise<RoutedResponse> {
    const processResponse = prepareResponseProcessor(options.responseContract);
    const route = await this.decide(prompt);
    const fingerprint = await this.adapter.getModelFingerprint();
    if (route.decision.fallbackReason === "model_fingerprint_changed") {
      this.store.markDrift(fingerprint.provider, fingerprint.model, route.decision.taskClass);
    }
    const makeRequest = (text: string): ModelRequest => ({
      model: fingerprint.model, prompt: text, mode: options.mode ?? "safe",
      scope: options.scope ?? "application_request",
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    });
    // A transport failure does not establish that the codec failed, nor that the
    // provider did not charge. Do not silently bill a second inference as a retry.
    const response = await this.adapter.invoke(makeRequest(route.compiledText));
    const decision = route.decision;
    const cost = response.cost ?? this.adapter.estimateCost?.(response.usage) ?? null;
    this.store.recordMetric({
      requestId: randomUUID(), scope: options.scope ?? "application_request",
      model: fingerprint.model, taskClass: decision.taskClass,
      codecId: decision.codecVersion, fallbackReason: decision.fallbackReason,
      usage: response.usage, cost, latencyMs: response.latencyMs,
    });
    const processed = processResponse(response.text);
    const quality: QualityResult = response.completionStatus === "incomplete" || !response.text.trim()
      ? { status: "rejected", validator: options.responseContract?.kind ?? null, reasons: ["incomplete_response"] }
      : processed.quality;
    if (quality.status === "rejected") throw new ResponseQualityError(quality, response.usage, cost, decision);
    let structuredResult: unknown = null;
    if (options.mode === "structured") {
      try { structuredResult = JSON.parse(processed.outputText) as unknown; } catch { /* unavailable */ }
    }
    return {
      response, decision, quality, outputText: processed.outputText, normalization: processed.normalization,
      semanticResult: options.mode === "agent" ? analyzePrompt(processed.outputText) : null,
      structuredResult,
    };
  }
}
