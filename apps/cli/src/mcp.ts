import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzePrompt, sha256 } from "@semantic-ir/core";
import type { TaskClass } from "@semantic-ir/core";
import { compilePrompt, DEFAULT_CODECS, RuntimeRouter, validateCompiled } from "@semantic-ir/engine";
import { adapterFor, openStore, runCalibration } from "./service.js";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export async function startMcpServer(): Promise<void> {
  const store = openStore();
  const server = new McpServer({ name: "semantic-ir", version: "0.1.0" });
  server.registerTool("analyze_prompt", {
    description: "Return a source-preserving Semantic IR with partial annotations. No provider call.",
    inputSchema: { prompt: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, ({ prompt }) => result(analyzePrompt(prompt)));

  server.registerTool("compile_prompt", {
    description: "Compile with a local declarative codec. This does not prove behavioral equivalence.",
    inputSchema: { prompt: z.string().min(1), codecId: z.string().default("original") },
    annotations: { readOnlyHint: true },
  }, ({ prompt, codecId }) => {
    const codec = store.getCodec(codecId) ?? DEFAULT_CODECS.find((item) => item.id === codecId);
    if (!codec) throw new Error("Codec not found");
    return result(compilePrompt(analyzePrompt(prompt), codec));
  });

  server.registerTool("validate_semantics", {
    description: "Run deterministic literal and constraint checks; open-ended semantic equivalence remains unavailable.",
    inputSchema: { prompt: z.string().min(1), compiledPrompt: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ prompt, compiledPrompt }) => {
    const ir = analyzePrompt(prompt);
    const failures = validateCompiled(ir, {
      text: compiledPrompt, codecId: "external", codecVersion: "unknown",
      sourceSha256: sha256(prompt), literalIds: ir.literals.map((item) => item.id),
    });
    return result({ deterministicChecksPassed: failures.length === 0, failures,
      behavioralEquivalence: "unavailable" });
  });

  server.registerTool("list_profiles", {
    description: "List local model/task profiles without prompt content.",
    annotations: { readOnlyHint: true },
  }, () => result(store.listProfiles()));

  server.registerTool("get_active_profile", {
    description: "Get a local model/task profile.",
    inputSchema: { provider: z.string(), model: z.string(), taskClass: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ provider, model, taskClass }) =>
    result(store.getProfile(provider, model, taskClass as TaskClass)));

  server.registerTool("get_metrics", {
    description: "Return measured request counts and fallback counts by optimization scope. No savings are inferred.",
    annotations: { readOnlyHint: true },
  }, () => result(store.metricsSummary()));

  server.registerTool("get_runtime_decision", {
    description: "Predict local routing without calling a provider.",
    inputSchema: { prompt: z.string().min(1), model: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ prompt, model }) => {
    const router = new RuntimeRouter(adapterFor(store, model), store);
    return result((await router.decide(prompt)).decision);
  });

  server.registerTool("explain_fallback", {
    description: "Explain why a prompt would use the original request.",
    inputSchema: { prompt: z.string().min(1), model: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ prompt, model }) => {
    const router = new RuntimeRouter(adapterFor(store, model), store);
    return result((await router.decide(prompt)).decision);
  });

  server.registerTool("doctor", {
    description: "Check local Semantic IR configuration without revealing credentials.",
    annotations: { readOnlyHint: true },
  }, () => result({
    databaseReady: true, providerKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    hostPrimaryPromptOptimization: "unavailable",
    controlledScopes: ["application_request", "downstream_llm_call"],
  }));

  server.registerTool("calibrate_model", {
    description: "PAID: calls the configured provider. Requires allowSpend=true and explicit hard budget.",
    inputSchema: {
      model: z.string().min(1), allowSpend: z.literal(true),
      maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().positive(), maxDurationMs: z.number().int().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ model, allowSpend, maxRequests, maxTokens, maxCostUsd, maxDurationMs }) =>
    result(await runCalibration({
      store, model, allowSpend, promote: true,
      budget: { maxRequests, maxTokens, maxCostUsd, maxDurationMs },
    })));

  server.registerTool("benchmark_codec", {
    description: "PAID: run the synthetic benchmark without promotion. Requires explicit spending budget.",
    inputSchema: {
      model: z.string().min(1), allowSpend: z.literal(true),
      maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().positive(), maxDurationMs: z.number().int().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ model, allowSpend, maxRequests, maxTokens, maxCostUsd, maxDurationMs }) =>
    result(await runCalibration({
      store, model, allowSpend, promote: false,
      budget: { maxRequests, maxTokens, maxCostUsd, maxDurationMs },
    })));

  await server.connect(new StdioServerTransport());
}
