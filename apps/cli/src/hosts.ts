import { spawnSync } from "node:child_process";
import type { AgentHostCapabilities, OptimizationScope } from "@semantic-ir/core";
import { selectIntegrationStrategy } from "@semantic-ir/core";

/** Conservative capabilities from the documented plugin surfaces, revision 1. */
export const CAPABILITY_MATRIX_REVISION = "2026-09-25.2";

const hostCapabilities: Record<"codex" | "claude-code" | "antigravity" | "generic-mcp", AgentHostCapabilities> = {
  codex: {
    host: "codex", hostVersion: null, skills: true, mcp: true, hooks: false,
    promptPreprocessing: false, promptReplacement: false, toolInterception: false,
    installScope: ["local"],
  },
  "claude-code": {
    host: "claude-code", hostVersion: null, skills: true, mcp: true, hooks: true,
    promptPreprocessing: false, promptReplacement: false, toolInterception: false,
    installScope: ["local"],
  },
  antigravity: {
    host: "antigravity", hostVersion: null, skills: true, mcp: true, hooks: true,
    promptPreprocessing: false, promptReplacement: false, toolInterception: false,
    installScope: ["user", "project"],
  },
  "generic-mcp": {
    host: "generic-mcp", hostVersion: null, skills: false, mcp: true, hooks: false,
    promptPreprocessing: false, promptReplacement: false, toolInterception: false,
    installScope: ["local"],
  },
};

const scopes: readonly OptimizationScope[] = [
  "host_primary_prompt", "downstream_llm_call", "application_request",
  "subagent_message", "agent_to_agent_message", "tool_payload", "shared_context",
];

function detectVersion(commands: readonly string[]): string | null {
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8", timeout: 2000, windowsHide: true,
    });
    if (result.status === 0) {
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
      if (version) return version.slice(0, 160);
    }
  }
  return null;
}

export function integrationReport(packages: { codex: boolean; claude: boolean; antigravity?: boolean }) {
  const hostVersions = {
    codex: detectVersion(["codex", "codex.exe"]),
    "claude-code": detectVersion(["claude", "claude.exe"]),
    antigravity: detectVersion(["agy", "agy.exe"]),
    "generic-mcp": null,
  };
  return (Object.keys(hostCapabilities) as (keyof typeof hostCapabilities)[]).map((host) => {
    const capabilities = { ...hostCapabilities[host], hostVersion: hostVersions[host] };
    const packageAvailable = host === "codex" ? packages.codex :
      host === "claude-code" ? packages.claude :
        host === "antigravity" ? Boolean(packages.antigravity) : true;
    return {
      host, matrixRevision: CAPABILITY_MATRIX_REVISION,
      hostDetected: host === "generic-mcp" ? null : hostVersions[host] !== null,
      packageAvailable, installed: "unverified",
      activeModelHint: null, capabilities,
      scopes: scopes.map((scope) => selectIntegrationStrategy(capabilities, scope)),
    };
  });
}
