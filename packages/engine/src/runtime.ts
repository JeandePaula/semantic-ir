import { randomUUID } from "node:crypto";
import { analyzePrompt } from "@semantic-ir/core";
import type {
  ModelAdapter, ModelRequest, ModelResponse, OptimizationScope,
  OutputMode, RuntimeDecision, SemanticIR,
} from "@semantic-ir/core";
import { compilePrompt } from "./codec.js";
import type { SqliteStore } from "./storage.js";

export interface RoutedResponse {
  readonly response: ModelResponse;
  readonly decision: RuntimeDecision;
  readonly semanticResult: SemanticIR | null;
  readonly structuredResult: unknown | null;
}

export function classifyRisk(ir: SemanticIR): RuntimeDecision["risk"] {
  const text = ir.source.text;
  if (ir.intent.task === "unknown") return "high";
  if (/\b(?:contract|legal advice|lawyer|tax|bank transfer|wire funds|contrato|jurídic|imposto)\b/i.test(text)) {
    return "high";
  }
  if (ir.constraints.length > 3 || text.length > 20_000) return "high";
  const literalLength = ir.literals.reduce((total, item) => total + item.text.length, 0);
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
      this.store.markDrift(fingerprint.provider, fingerprint.model, ir.intent.task);
      return fallback("model_fingerprint_changed");
    }
    if (profile.status !== "stable") return fallback("profile_needs_reverification");
    const codec = this.store.getCodec(profile.codecId);
    if (!codec) return fallback("codec_missing");
    try {
      const compiled = compilePrompt(ir, codec);
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
  } = {}): Promise<RoutedResponse> {
    const route = await this.decide(prompt);
    const fingerprint = await this.adapter.getModelFingerprint();
    const makeRequest = (text: string): ModelRequest => ({
      model: fingerprint.model, prompt: text, mode: options.mode ?? "safe",
      scope: options.scope ?? "application_request",
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    });
    let response: ModelResponse;
    let decision = route.decision;
    try {
      response = await this.adapter.invoke(makeRequest(route.compiledText));
    } catch (error) {
      if (decision.mode === "original") throw error;
      decision = {
        ...decision, mode: "original", codecVersion: null,
        fallbackReason: "compiled_provider_call_failed",
      };
      response = await this.adapter.invoke(makeRequest(prompt));
    }
    const cost = this.adapter.estimateCost?.(response.usage) ?? null;
    this.store.recordMetric({
      requestId: randomUUID(), scope: options.scope ?? "application_request",
      model: fingerprint.model, taskClass: decision.taskClass,
      codecId: decision.codecVersion, fallbackReason: decision.fallbackReason,
      usage: response.usage, cost, latencyMs: response.latencyMs,
    });
    let structuredResult: unknown = null;
    if (options.mode === "structured") {
      try { structuredResult = JSON.parse(response.text) as unknown; } catch { /* unavailable */ }
    }
    return {
      response, decision,
      semanticResult: options.mode === "agent" ? analyzePrompt(response.text) : null,
      structuredResult,
    };
  }
}
