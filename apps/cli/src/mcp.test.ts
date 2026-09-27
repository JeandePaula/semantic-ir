import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP stdio integration", () => {
  it("handshakes and exposes read-only analysis without provider credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-ir-mcp-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "mcp"],
      env: { ...process.env, SEMANTIC_IR_DB: join(dir, "state.sqlite"), OPENAI_API_KEY: "" },
    });
    const client = new Client({ name: "semantic-ir-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((item) => item.name)).toContain("analyze_prompt");
      expect(tools.tools.map((item) => item.name)).toContain("calibrate_model");
      expect(tools.tools.map((item) => item.name)).toContain("audit_prompt");
      const audit = await client.callTool({ name: "audit_prompt", arguments: { prompt: "Extract BLUE." } });
      const auditText = audit.content[0];
      if (auditText?.type !== "text") throw new Error("Expected audit response");
      expect(JSON.parse(auditText.text)).toMatchObject({ providerCalls: 0, recommendedCodecId: null });
      const prompt = 'Extract the code.\n{ "code": 8500 }';
      const validation = await client.callTool({ name: "validate_semantics", arguments: {
        prompt, compiledPrompt: 'Extract the code.\n{"code":8500}', transformation: "json_whitespace",
      } });
      const validationText = validation.content[0];
      if (validationText?.type !== "text") throw new Error("Expected validation response");
      expect(JSON.parse(validationText.text)).toMatchObject({ deterministicChecksPassed: true });
      const response = await client.callTool({
        name: "analyze_prompt", arguments: { prompt: "Never change 7500." },
      });
      const text = response.content[0];
      expect(text?.type).toBe("text");
      if (text?.type === "text") {
        const ir = JSON.parse(text.text) as { source: { text: string } };
        expect(ir.source.text).toBe("Never change 7500.");
      }
      const doctor = await client.callTool({ name: "doctor", arguments: {} });
      const doctorText = doctor.content[0];
      expect(doctorText?.type).toBe("text");
      if (doctorText?.type === "text") {
        expect(JSON.parse(doctorText.text)).toMatchObject({ providerKeyConfigured: false });
      }
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
