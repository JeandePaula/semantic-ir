import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("executes and verifies local file artifacts without opening a database or requiring a provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-ir-local-"));
  const input = join(dir, "task.json");
  const output = join(dir, "answer.json");
  const contract = join(dir, "contract.json");
  const db = join(dir, "db.sqlite");
  const cli = (...args: string[]) => spawnSync(process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url)), ...args], {
      encoding: "utf8", env: { ...process.env, SEMANTIC_IR_DB: db, OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
  try {
    writeFileSync(input, JSON.stringify({ kind: "json_select_v1", data: { code: "GREEN" }, path: ["code"] }));
    const run = cli("execute", "--file", input, "--out", output);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ outputFile: output, usage: { providerCalls: 0 } });
    expect(JSON.parse(run.stdout)).not.toHaveProperty("result");
    expect(JSON.parse(readFileSync(output, "utf8"))).toBe("GREEN");
    expect(existsSync(db)).toBe(false);
    expect(cli("execute", "--file", input, "--out", output).status).toBe(1);
    writeFileSync(contract, JSON.stringify({ kind: "exact_json", expected: '"GREEN"' }));
    expect(cli("verify", "--contract", contract, "--file", output).status).toBe(0);
    writeFileSync(output, '"WRONG"');
    const failed = cli("verify", "--contract", contract, "--file", output);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "rejected" });
    writeFileSync(input, '{"kind":"json_select_v1","data":{"x":1,"x":2},"path":["x"]}');
    expect(cli("execute", "--file", input).status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
