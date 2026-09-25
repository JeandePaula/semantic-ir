#!/usr/bin/env node
import { readFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { analyzePrompt, TaskClassSchema, type BenchmarkSuite } from "@semantic-ir/core";
import {
  compilePrompt, DEFAULT_CODECS, RuntimeRouter, SYNTHETIC_SUITE,
  type OpenAIPrice,
} from "@semantic-ir/engine";
import { createGateway } from "./gateway.js";
import { integrationReport } from "./hosts.js";
import { startMcpServer } from "./mcp.js";
import {
  adapterFor, databasePath, openStore, providerFor, providerKey,
  runCalibration, saveProviderKey,
} from "./service.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const option = (name: string): string | undefined => {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string): boolean => argv.includes("--" + name);
const required = (name: string): string => {
  const value = option(name);
  if (!value || value.startsWith("--")) throw new Error("Missing --" + name);
  return value;
};
const positiveNumber = (name: string): number => {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error("--" + name + " must be positive");
  return value;
};
const nonnegativeNumber = (name: string): number => {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value < 0) throw new Error("--" + name + " must be nonnegative");
  return value;
};
const positiveInteger = (name: string): number => {
  const value = positiveNumber(name);
  if (!Number.isSafeInteger(value)) throw new Error("--" + name + " must be an integer");
  return value;
};
const print = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); };
const integrationsDir = fileURLToPath(new URL("../assets/integrations/", import.meta.url));

async function readSecretInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    let secret = "";
    for await (const chunk of process.stdin) {
      secret += String(chunk);
      if (secret.length > 4096) throw new Error("API key input too large");
    }
    return secret.trim();
  }
  process.stderr.write("API key (hidden): ");
  return new Promise<string>((resolve, reject) => {
    let secret = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(secret.trim());
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003") { finish(new Error("Cancelled")); return; }
        if (char === "\u007f" || char === "\b") secret = secret.slice(0, -1);
        else secret += char;
        if (secret.length > 4096) { finish(new Error("API key input too large")); return; }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function model(store: ReturnType<typeof openStore>): string {
  return option("model") ?? store.getSetting<string>("defaultModel") ?? "";
}

function budget() {
  return {
    maxRequests: positiveInteger("max-requests"),
    maxTokens: positiveInteger("max-tokens"),
    maxCostUsd: positiveNumber("max-cost-usd"),
    maxDurationMs: positiveInteger("max-duration-ms"),
  };
}

function suite(): BenchmarkSuite {
  const path = option("suite");
  if (!path) return SYNTHETIC_SUITE;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return z.object({
    id: z.string(), version: z.string(),
    cases: z.array(z.object({
      id: z.string(), version: z.string(),
      category: z.string().optional(),
      split: z.enum(["calibration", "validation", "holdout"]),
      taskClass: TaskClassSchema, prompt: z.string().min(1),
      expectedLiterals: z.array(z.string()), expectedConstraints: z.array(z.string()),
      oracleId: z.string().nullable(), expectedOutput: z.string().optional(),
    })),
  }).parse(parsed) as BenchmarkSuite;
}

async function main(): Promise<void> {
  if (command === "mcp") {
    await startMcpServer();
    return;
  }
  const store = openStore();
  try {
    if (command === "help") {
      print({ commands: [
        "init", "configure --provider openai|openrouter --model MODEL [price options]",
        "credentials import --provider openrouter < keyfile", "credentials status",
        "analyze PROMPT", "compile --codec ID PROMPT", "doctor", "profile", "codecs list|inspect",
        "invoke --allow-spend --max-output-tokens N --prompt PROMPT",
        "calibrate|benchmark|optimize --model MODEL --allow-spend --max-requests N --max-tokens N --max-cost-usd N --max-duration-ms N",
        "rollback --provider openai --model MODEL --task TASK", "metrics",
        "proxy --port 8787", "mcp", "integrations list|status|doctor|build",
        "install codex|claude|generic-mcp", "uninstall codex|claude",
      ] });
      return;
    }
    if (command === "init") {
      for (const codec of DEFAULT_CODECS) store.saveCodec(codec, "candidate");
      print({ database: databasePath(), codecs: DEFAULT_CODECS.map((item) => item.id) });
      return;
    }
    if (command === "configure") {
      const selectedModel = required("model");
      const selectedProvider = z.enum(["openai", "openrouter"]).parse(option("provider") ?? "openai");
      const hasPriceOption = ["price-version", "input-price", "cached-price", "output-price"]
        .some((name) => option(name) !== undefined);
      const price: OpenAIPrice | null = hasPriceOption ? {
        version: required("price-version"),
        inputUsdPerMillion: positiveNumber("input-price"),
        cachedInputUsdPerMillion: nonnegativeNumber("cached-price"),
        outputUsdPerMillion: positiveNumber("output-price"),
      } : null;
      store.setSetting("defaultModel", selectedModel);
      store.setSetting("defaultProvider", selectedProvider);
      if (price) store.setSetting("price:" + selectedProvider + ":" + selectedModel, price);
      print({ provider: selectedProvider, model: selectedModel, price, apiKeyStoredInDatabase: false });
      return;
    }
    if (command === "credentials") {
      if (argv[1] === "status") {
        const provider = providerFor(store);
        print({ provider, configured: Boolean(providerKey(provider)) });
        return;
      }
      if (argv[1] === "import") {
        const provider = z.enum(["openai", "openrouter"]).parse(required("provider"));
        const path = saveProviderKey(provider, await readSecretInput());
        print({ provider, stored: true, path, permissions: "0600" });
        return;
      }
      throw new Error("Use credentials import or credentials status");
    }
    if (command === "analyze") {
      const prompt = argv.slice(1).join(" ");
      print(analyzePrompt(prompt));
      return;
    }
    if (command === "compile") {
      const codecId = required("codec");
      const prompt = argv.slice(argv.indexOf(codecId) + 1).join(" ");
      const codec = store.getCodec(codecId) ?? DEFAULT_CODECS.find((item) => item.id === codecId);
      if (!codec) throw new Error("Codec not found");
      print(compilePrompt(analyzePrompt(prompt), codec));
      return;
    }
    if (command === "doctor") {
      const provider = providerFor(store);
      print({
        database: databasePath(), databaseReady: true,
        provider, providerKeyConfigured: Boolean(providerKey(provider)),
        model: model(store) || null,
        codexPackage: existsSync(join(integrationsDir, "codex", "plugins", "semantic-ir", "plugin.json")),
        claudePackage: existsSync(join(integrationsDir, "claude-code", "plugins", "semantic-ir", ".claude-plugin", "plugin.json")),
        hostPrimaryPromptOptimization: "unavailable",
      });
      return;
    }
    if (command === "invoke") {
      if (!has("allow-spend")) throw new Error("Provider calls require --allow-spend");
      const selectedModel = model(store);
      if (!selectedModel) throw new Error("Set --model or run configure");
      const prompt = required("prompt");
      const adapter = adapterFor(store, selectedModel);
      const router = new RuntimeRouter(adapter, store);
      const routed = await router.invoke(prompt, {
        scope: "application_request", maxOutputTokens: positiveInteger("max-output-tokens"),
      });
      print({
        provider: providerFor(store), model: selectedModel,
        response: routed.response.text, usage: routed.response.usage,
        latencyMs: routed.response.latencyMs,
        cost: routed.response.cost ?? adapter.estimateCost(routed.response.usage),
        decision: routed.decision,
      });
      return;
    }
    if (command === "profile") {
      print(store.listProfiles());
      return;
    }
    if (command === "codecs") {
      if (argv[1] === "list") print(store.listCodecs());
      else if (argv[1] === "inspect") print(store.getCodec(argv[2] ?? ""));
      else throw new Error("Use codecs list or codecs inspect ID");
      return;
    }
    if (command === "metrics") {
      print({ ...store.metricsSummary(), verifiedSavings: "unavailable" });
      return;
    }
    if (command === "calibrate" || command === "benchmark" || command === "optimize") {
      const selectedModel = model(store);
      if (!selectedModel) throw new Error("Set --model or run configure");
      if (!has("allow-spend")) throw new Error("Paid calls require --allow-spend");
      const taskClass = TaskClassSchema.parse(option("task") ?? "extraction");
      const report = await runCalibration({
        store, model: selectedModel, budget: budget(), taskClass,
        suite: suite(), allowSpend: true, promote: command !== "benchmark",
      });
      print(report);
      return;
    }
    if (command === "rollback") {
      const task = TaskClassSchema.parse(required("task"));
      print({ restoredCodec: store.rollback(required("provider"), required("model"), task) });
      return;
    }
    if (command === "proxy") {
      const port = Number(option("port") ?? "8787");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
      const server = createGateway(store);
      server.listen(port, "127.0.0.1", () => {
        print({ gateway: "http://127.0.0.1:" + port, scope: "application_request" });
      });
      // Keep the store open for the server lifetime.
      return;
    }
    if (command === "integrations" || command === "install" || command === "uninstall") {
      const action = command === "integrations" ? argv[1] : command;
      const host = command === "integrations" ? undefined : argv[1];
      const codexRoot = join(integrationsDir, "codex");
      const claudeRoot = join(integrationsDir, "claude-code");
      const available = { codex: existsSync(codexRoot), claude: existsSync(claudeRoot) };
      if (action === "build") {
        const output = resolve(option("out") ?? join(process.cwd(), "dist"));
        if (output === integrationsDir || output.startsWith(integrationsDir + sep)) {
          throw new Error("Integration output cannot be inside package assets");
        }
        mkdirSync(output, { recursive: true });
        for (const name of ["codex", "claude-code", "generic-mcp"]) {
          cpSync(join(integrationsDir, name), join(output, name), { recursive: true, force: true });
        }
        print({ output, hosts: ["codex", "claude-code", "generic-mcp"] });
        return;
      }
      if (action === "list" || action === "status" || action === "doctor") {
        print({ available, hosts: integrationReport(available), hostPrimaryPromptOptimization: "unavailable",
          controlledScopes: ["application_request", "downstream_llm_call"],
          packageRoot: integrationsDir });
        return;
      }
      if (action === "install" && host === "codex") {
        print({ installed: false, packageRoot: codexRoot, steps: [
          "Install @semantic-ir/cli globally so the plugin can launch semantic-ir mcp",
          "codex plugin marketplace add " + codexRoot,
          "codex plugin add semantic-ir@semantic-ir-local",
        ] });
        return;
      }
      if (action === "install" && host === "claude") {
        print({ installed: false, packageRoot: claudeRoot, steps: [
          "Install @semantic-ir/cli globally so the plugin can launch semantic-ir mcp",
          "claude plugin validate " + join(claudeRoot, "plugins", "semantic-ir"),
          "claude plugin marketplace add " + claudeRoot,
          "claude plugin install semantic-ir@semantic-ir-local",
        ] });
        return;
      }
      if (action === "install" && host === "generic-mcp") {
        print({ installed: false, command: "semantic-ir", args: ["mcp"], transport: "stdio" });
        return;
      }
      if (action === "uninstall" && host === "claude") {
        print({ uninstalled: false, steps: ["claude plugin uninstall semantic-ir@semantic-ir-local"] });
        return;
      }
      if (action === "uninstall" && host === "codex") {
        print({ uninstalled: false, steps: ["codex plugin remove semantic-ir@semantic-ir-local",
          "codex plugin marketplace remove semantic-ir-local"] });
        return;
      }
      throw new Error("Unsupported integration command");
    }
    throw new Error("Unknown command: " + command);
  } finally {
    if (command !== "proxy") store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write("semantic-ir: " + message + "\n");
  process.exitCode = 1;
});
