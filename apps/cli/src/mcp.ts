import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzePrompt, sha256 } from "@semantic-ir/core";
import type { TaskClass } from "@semantic-ir/core";
import { compilePrompt, DEFAULT_CODECS, REDUNDANT_EXTRACTION_SUITE,
  RuntimeRouter, SYNTHETIC_SUITE, validateCompiled } from "@semantic-ir/engine";
import { adapterFor, openStore, providerFor, providerKey, runCalibration } from "./service.js";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export async function startMcpServer(): Promise<void> {
  const store = openStore();
  const server = new McpServer({ name: "semantic-ir", version: "0.3.0" });
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
    description: "Return request counts, fallbacks, and separately labeled measured/estimated costs. No savings are inferred.",
    annotations: { readOnlyHint: true },
  }, () => result(store.metricsSummary()));

  server.registerTool("get_calibration_report", {
    description: "Return the latest measured calibration report for the configured provider and model, without prompt text.",
    inputSchema: { model: z.string().min(1).optional() },
    annotations: { readOnlyHint: true },
  }, ({ model }) => {
    const selectedModel = model ?? store.getSetting<string>("defaultModel");
    if (!selectedModel) throw new Error("Configure a model first");
    return result(store.getLatestCalibrationReport(providerFor(store), selectedModel));
  });

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
    databaseReady: true, provider: providerFor(store),
    providerKeyConfigured: Boolean(providerKey(providerFor(store))),
    hostPrimaryPromptOptimization: "unavailable",
    controlledScopes: ["application_request", "downstream_llm_call"],
  }));

  server.registerTool("invoke_prompt", {
    description: "PAID: send one controlled downstream prompt to the configured provider and report the real response, usage, cost, and routing decision. Requires explicit spending consent.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      model: z.string().min(1).optional(),
      allowSpend: z.literal(true),
      maxOutputTokens: z.number().int().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ prompt, model, maxOutputTokens }) => {
    const selectedModel = model ?? store.getSetting<string>("defaultModel");
    if (!selectedModel) throw new Error("Configure a model first with semantic-ir configure");
    const adapter = adapterFor(store, selectedModel);
    const routed = await new RuntimeRouter(adapter, store).invoke(prompt, {
      scope: "downstream_llm_call", maxOutputTokens,
    });
    return result({
      provider: providerFor(store), model: selectedModel,
      response: routed.response.text, usage: routed.response.usage,
      latencyMs: routed.response.latencyMs,
      cost: routed.response.cost ?? adapter.estimateCost(routed.response.usage),
      decision: routed.decision,
    });
  });

  server.registerTool("calibrate_model", {
    description: "PAID: calls the configured provider. Requires allowSpend=true and explicit budget; OpenRouter USD preflight is estimated.",
    inputSchema: {
      model: z.string().min(1), allowSpend: z.literal(true),
      maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().positive(), maxDurationMs: z.number().int().positive(),
      suite: z.enum(["redundant-extraction", "synthetic-exact"]).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ model, allowSpend, maxRequests, maxTokens, maxCostUsd, maxDurationMs,
    suite, maxOutputTokens }) =>
    result(await runCalibration({
      store, model, allowSpend, promote: true,
      budget: { maxRequests, maxTokens, maxCostUsd, maxDurationMs },
      ...(suite ? { suite: suite === "redundant-extraction" ? REDUNDANT_EXTRACTION_SUITE : SYNTHETIC_SUITE } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })));

  server.registerTool("benchmark_codec", {
    description: "PAID: run the synthetic benchmark without promotion. Requires explicit spending budget.",
    inputSchema: {
      model: z.string().min(1), allowSpend: z.literal(true),
      maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().positive(), maxDurationMs: z.number().int().positive(),
      suite: z.enum(["redundant-extraction", "synthetic-exact"]).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ model, allowSpend, maxRequests, maxTokens, maxCostUsd, maxDurationMs,
    suite, maxOutputTokens }) =>
    result(await runCalibration({
      store, model, allowSpend, promote: false,
      budget: { maxRequests, maxTokens, maxCostUsd, maxDurationMs },
      ...(suite ? { suite: suite === "redundant-extraction" ? REDUNDANT_EXTRACTION_SUITE : SYNTHETIC_SUITE } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })));

  await server.connect(new StdioServerTransport());
}
