import type {
  AgentHostCapabilities, IntegrationRuntimeMode, OptimizationScope,
} from "./contracts.js";

export interface ScopeAvailability {
  readonly scope: OptimizationScope;
  readonly available: boolean;
  readonly mode: IntegrationRuntimeMode | null;
  readonly reason: string | null;
}

/** Capabilities are supplied by a host adapter; no host details enter the core. */
export function selectIntegrationStrategy(
  capabilities: AgentHostCapabilities,
  scope: OptimizationScope,
): ScopeAvailability {
  if (scope === "host_primary_prompt") {
    if (capabilities.promptReplacement && capabilities.promptPreprocessing) {
      return { scope, available: true, mode: "native-plugin", reason: null };
    }
    return {
      scope, available: false, mode: null,
      reason: "No verified pre-inference primary prompt replacement",
    };
  }
  if (scope === "application_request" || scope === "downstream_llm_call") {
    return { scope, available: true, mode: "gateway", reason: null };
  }
  if (capabilities.mcp || capabilities.skills) {
    return { scope, available: true, mode: "explicit-skill", reason: null };
  }
  return { scope, available: false, mode: null, reason: "Host has no supported explicit integration" };
}
