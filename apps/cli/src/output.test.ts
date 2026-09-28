import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SqliteStore } from "@semantic-ir/engine";

it("passes native output shapes through CLI and MCP, returning the validated value with no real network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-ir-output-"));
  const db = join(dir, "state.sqlite");
  const capture = join(dir, "request.json");
  const mock = join(dir, "mock.mjs");
  const shape = join(dir, "shape.json");
  const contract = join(dir, "contract.json");
  const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const store = new SqliteStore(db);
  store.setSetting("defaultProvider", "openrouter");
  store.setSetting("defaultModel", "fixture");
  store.close();
  // This preload intercepts every fetch in the child before importing the CLI.
  writeFileSync(mock, `import { writeFileSync } from 'node:fs';
    globalThis.fetch = async (_url, init) => {
      writeFileSync(${JSON.stringify(capture)}, init.body);
      return new Response(JSON.stringify({model:'fixture',choices:[{finish_reason:'stop',message:{content:'{"value":"CORAL"}'}}],
        usage:{prompt_tokens:100,completion_tokens:10,cost:0.0001}}),{status:200});
    };`);
  writeFileSync(shape, '{"type":"string"}');
  writeFileSync(contract, JSON.stringify({ kind: "exact_json", expected: '"CORAL"' }));
  const env = { ...process.env, SEMANTIC_IR_DB: db, OPENROUTER_API_KEY: "fixture", OPENAI_API_KEY: "" };
  const client = new Client({ name: "native-output-test", version: "1" });
  try {
    const invoked = spawnSync(process.execPath, ["--import", mock, main, "invoke", "--allow-spend", "--max-output-tokens", "128",
      "--prompt", "Extract the requested color", "--contract", contract, "--output-shape", shape], { encoding: "utf8", env });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(JSON.parse(invoked.stdout)).toMatchObject({ response: '"CORAL"', quality: { status: "verified" }, outputProtocol: "json-envelope/1" });
    expect(JSON.parse(readFileSync(capture, "utf8")).provider.require_parameters).toBe(true);
    expect(readFileSync(capture, "utf8")).not.toContain("CORAL");

    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", mock, main, "mcp"], env }));
    const called = await client.callTool({ name: "invoke_prompt", arguments: { prompt: "Extract the requested color", allowSpend: true,
      maxOutputTokens: 128, outputShape: { type: "string" }, responseContract: { kind: "exact_json", expected: '"CORAL"' } } });
    const content = called.content[0];
    if (content?.type !== "text") throw new Error("Expected MCP response");
    expect(called.isError).not.toBe(true);
    expect(JSON.parse(content.text)).toMatchObject({ response: '"CORAL"', quality: { status: "verified" }, outputProtocol: "json-envelope/1" });
    expect(JSON.parse(readFileSync(capture, "utf8")).response_format.json_schema.schema.properties.value).toEqual({ type: "string" });
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
