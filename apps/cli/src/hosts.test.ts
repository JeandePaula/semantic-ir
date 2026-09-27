import { describe, expect, it } from "vitest";
import { integrationReport } from "./hosts.js";

describe("host capability matrix", () => {
  it("does not claim primary prompt replacement or installation", () => {
    const report = integrationReport({ codex: true, claude: false });
    expect(report.map((host) => host.host)).toEqual(["codex", "claude-code", "antigravity", "generic-mcp"]);
    for (const host of report) {
      expect(host.installed).toBe("unverified");
      expect(host.capabilities.promptReplacement).toBe(false);
      expect(host.scopes.find((item) => item.scope === "host_primary_prompt")?.available).toBe(false);
    }
    expect(report.find((item) => item.host === "claude-code")?.packageAvailable).toBe(false);
  });
});
