import { expect, it } from "vitest";
import { selectIntegrationStrategy, type AgentHostCapabilities } from "./index.js";

it("does not claim primary-prompt savings from skills or hooks alone", () => {
  const capabilities: AgentHostCapabilities = {
    host: "codex", hostVersion: null, skills: true, mcp: true, hooks: true,
    promptPreprocessing: false, promptReplacement: false, toolInterception: false,
    installScope: ["user", "project"],
  };
  expect(selectIntegrationStrategy(capabilities, "host_primary_prompt")).toMatchObject({
    available: false, mode: null,
  });
  expect(selectIntegrationStrategy(capabilities, "downstream_llm_call")).toMatchObject({
    available: true, mode: "gateway",
  });
});
