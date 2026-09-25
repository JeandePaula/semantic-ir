import type { SemanticIR, TaskClass } from "@semantic-ir/semantic-ir";

export type OutputMode = "safe" | "structured" | "agent";
export type EvidenceStatus = "measured" | "estimated" | "unavailable";
export type CodecStatus = "experimental" | "candidate" | "stable" | "deprecated" | "rejected";
export type OptimizationScope =
  | "host_primary_prompt" | "downstream_llm_call" | "subagent_message"
  | "agent_to_agent_message" | "tool_payload" | "shared_context" | "application_request";
export type IntegrationRuntimeMode = "native-plugin" | "hook" | "gateway" | "explicit-skill";

export interface AgentHostCapabilities {
  readonly host: "codex" | "claude-code" | string;
  readonly hostVersion: string | null;
  readonly skills: boolean;
  readonly mcp: boolean;
  readonly hooks: boolean;
  readonly promptPreprocessing: boolean;
  readonly promptReplacement: boolean;
  readonly toolInterception: boolean;
  readonly installScope: readonly ("user" | "project" | "local" | "remote")[];
}

export interface AgentHostFingerprint {
  readonly host: string;
  readonly version: string | null;
  readonly capabilitiesSha256: string;
}

export interface AgentIntegrationConfig {
  readonly host: string;
  readonly enabled: boolean;
  readonly mode: IntegrationRuntimeMode;
  readonly scopes: readonly OptimizationScope[];
  readonly dataDirectory: string;
}

export interface IntegrationStatus {
  readonly host: string;
  readonly installed: boolean;
  readonly mcpAvailable: boolean;
  readonly primaryPromptOptimization: "available" | "unavailable";
  readonly issues: readonly string[];
}

export interface AgentPluginAdapter {
  detectHost(): Promise<boolean>;
  detectCapabilities(): Promise<AgentHostCapabilities>;
  getHostVersion(): Promise<string | null>;
  getActiveModelHint(): Promise<string | null>;
  getWritableDataDirectory(): Promise<string | null>;
  getIntegrationScope(): Promise<AgentIntegrationConfig["mode"] | null>;
  doctor(): Promise<IntegrationStatus>;
}

/** Data only: no expression, callback, executable module, or dynamic import. */
export interface CodecDefinition {
  readonly schemaVersion: "codec/0.1";
  readonly id: string;
  readonly strategy: "identity" | "compact_spacing" | "tagged";
  readonly aliases: Partial<Record<keyof SemanticIR, string>>;
  readonly separator: string;
  readonly assignment: string;
  readonly fieldOrder: readonly (keyof SemanticIR)[];
  readonly nesting: "nested" | "flat";
  readonly flattenSingletons: boolean;
  readonly referenceLiterals: boolean;
  readonly referenceEntities: boolean;
  readonly enumAliases: Readonly<Record<string, string>>;
  readonly constraintEncoding: "explicit" | "symbolic";
  readonly relationshipEncoding: "explicit" | "symbolic";
  readonly omitNull: boolean;
  readonly omitDefaults: boolean;
  readonly omitNonsemanticMetadata: boolean;
  readonly deduplicateRepeatedValues: boolean;
}

export interface CompiledPrompt {
  readonly text: string;
  readonly codecId: string;
  readonly codecVersion: string;
  readonly sourceSha256: string;
  readonly literalIds: readonly string[];
}

export interface ModelCapabilities {
  readonly tokenCounting: boolean;
  readonly reasoningMetadata: boolean;
  readonly structuredOutput: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly contextSize: number | null;
  readonly tokenizerId: string | null;
}

export interface ModelFingerprint {
  readonly provider: string;
  readonly model: string;
  readonly snapshot: string | null;
  readonly capabilities: ModelCapabilities;
  readonly fingerprintSha256: string;
  readonly observedAt: string;
}

export interface ModelRequest {
  readonly model: string;
  readonly prompt: string;
  readonly mode: OutputMode;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly scope?: OptimizationScope;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface UsageMetrics {
  /** Total input tokens; cachedInputTokens is a subset, not an additional count. */
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly source: "provider_usage" | "provider_count_endpoint" | "official_tokenizer" | "unavailable";
}

export interface CostMetrics {
  readonly amountUsd: number | null;
  readonly status: EvidenceStatus;
  readonly priceVersion: string | null;
  readonly category: "user_inference" | "calibration" | "evaluation";
}

export interface ModelResponse {
  readonly text: string;
  readonly usage: UsageMetrics;
  readonly cost?: CostMetrics;
  readonly latencyMs: number;
  readonly providerRequestId: string | null;
  readonly modelFingerprint: ModelFingerprint;
}

export interface ModelStreamEvent {
  readonly type: "text_delta" | "usage" | "complete";
  readonly text?: string;
  readonly usage?: UsageMetrics;
}

export interface TokenCount {
  readonly inputTokens: number;
  readonly source: "provider_count_endpoint" | "official_tokenizer";
}

export interface ModelAdapter {
  invoke(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  countTokens?(request: ModelRequest): Promise<TokenCount | null>;
  estimateCost?(usage: UsageMetrics): CostMetrics | null;
  getCapabilities(): ModelCapabilities;
  getModelFingerprint(): Promise<ModelFingerprint>;
}

export interface TokenAccountingAdapter {
  count(request: ModelRequest): Promise<TokenCount | null>;
  readUsage(response: ModelResponse): UsageMetrics;
}

export interface CodecVersion {
  readonly id: string;
  readonly version: string;
  readonly definition: CodecDefinition;
  readonly definitionSha256: string;
  readonly status: CodecStatus;
  readonly parentVersion: string | null;
}

export interface TaskProfile {
  readonly taskClass: TaskClass;
  readonly contextBand: "short" | "medium" | "long";
  readonly reasoningLevel: string | null;
  readonly stableCodecVersion: string | null;
  readonly state: "ready" | "needs_reverification" | "uncalibrated";
}

export interface ModelProfile {
  readonly schemaVersion: "profile/0.1";
  readonly fingerprint: ModelFingerprint;
  readonly sirVersion: "sir/0.1";
  readonly tasks: readonly TaskProfile[];
  readonly calibratedAt: string | null;
}

export interface BenchmarkCase {
  readonly id: string;
  readonly version: string;
  readonly category?: string;
  readonly split: "calibration" | "validation" | "holdout";
  readonly taskClass: TaskClass;
  readonly prompt: string;
  readonly expectedLiterals: readonly string[];
  readonly expectedConstraints: readonly string[];
  readonly oracleId: string | null;
  readonly expectedOutput?: string;
}

export interface BenchmarkSuite {
  readonly id: string;
  readonly version: string;
  readonly cases: readonly BenchmarkCase[];
}

export interface EvaluationResult {
  readonly caseId: string;
  readonly codecVersion: string | null;
  readonly schemaValid: boolean;
  readonly literalPreservation: number | null;
  readonly hardConstraintPreservation: number | null;
  readonly negationPreservation: number | null;
  readonly semanticFidelity: number | null;
  readonly taskSuccess: boolean | null;
  readonly qualityRatioToBaseline: number | null;
  readonly behavioralEquivalence: number | null;
  readonly passedHardGates: boolean;
  readonly evidenceStatus: EvidenceStatus;
  readonly reasons: readonly string[];
}

export interface CalibrationBudget {
  readonly maxRequests: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly maxDurationMs: number;
}

export interface CodecCandidate {
  readonly codec: CodecVersion;
  readonly fitness: number | null;
  readonly evaluations: readonly EvaluationResult[];
}

export interface OptimizationInput {
  readonly fingerprint: ModelFingerprint;
  readonly taskClass: TaskClass;
  readonly suite: BenchmarkSuite;
  readonly seeds: readonly CodecVersion[];
  readonly budget: CalibrationBudget;
}

export interface OptimizationRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly fingerprintSha256: string;
  readonly taskClass: TaskClass;
  readonly candidates: readonly CodecCandidate[];
  readonly usedRequests: number;
  readonly usedTokens: number;
  readonly usedCostUsd: number | null;
  readonly status: "running" | "completed" | "budget_exhausted" | "failed";
}

export interface Optimizer {
  optimize(input: OptimizationInput): Promise<OptimizationRun>;
}

export interface RuntimeDecision {
  readonly mode: "original" | "compiled";
  readonly codecVersion: string | null;
  readonly fallbackReason: string | null;
  readonly taskClass: TaskClass;
  readonly risk: "low" | "medium" | "high" | "unknown";
  readonly fingerprintSha256: string;
}

export interface SemanticState {
  readonly id: string;
  readonly version: string;
  readonly ir: SemanticIR;
  readonly parentStateId: string | null;
}

export interface SemanticDelta {
  readonly baseStateId: string;
  readonly version: string;
  readonly operations: readonly {
    readonly op: "add" | "remove" | "replace";
    readonly path: string;
    readonly value?: unknown;
  }[];
}
