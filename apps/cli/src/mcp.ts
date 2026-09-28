import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzePrompt, sha256 } from "@semantic-ir/core";
import type { TaskClass } from "@semantic-ir/core";
import { auditPrompt, compilePrompt, DEFAULT_CODECS, diagnoseReport, JSON_EXTRACTION_SUITE, REDUNDANT_EXTRACTION_SUITE,
  RuntimeRouter, SYNTHETIC_SUITE, validateCompiled, executeLocalTask, LocalTaskSchema,
  ResponseContractSchema, prepareResponseValidator, ResponseQualityError,
  JsonQuerySchema, compileJsonQuery, JsonOutputShapeSchema } from "@semantic-ir/engine";
import { adapterFor, openStore, providerFor, providerKey, runCalibration } from "./service.js";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export async function startMcpServer(): Promise<void> {
  const store = openStore();
  const server = new McpServer({ name: "semantic-ir", version: "0.3.1" });
  server.registerTool("execute_local", {
    description: "Execute an explicit versioned JSON selection, query pipeline or order-allocation contract locally. Zero downstream LLM calls. Does not infer rules from prose.",
    inputSchema: { task: LocalTaskSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ task }) => result(executeLocalTask(task)));
  server.registerTool("plan_local_query", {
    description: "Compile an explicit JSON query to a local typed plan with source hashes. Does not infer rules from prose or call a provider.",
    inputSchema: { task: JsonQuerySchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ task }) => result(compileJsonQuery(task)));
  server.registerTool("verify_response", {
    description: "Check a complete answer against a trusted exact text or JSON reference. Local; no provider calls. Valid JSON alone is not correctness.",
    inputSchema: { response: z.string().max(1_000_000), contract: ResponseContractSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ response, contract }) => result(prepareResponseValidator(contract)(response)));
  server.registerTool("audit_prompt", {
    description: "Compare local compression candidates before spending. Reports bytes, never unmeasured token or cost savings.",
    inputSchema: { prompt: z.string().min(1).max(1_000_000) },
    annotations: { readOnlyHint: true },
  }, ({ prompt }) => result(auditPrompt(prompt)));
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
    inputSchema: { prompt: z.string().min(1), compiledPrompt: z.string(),
      transformation: z.literal("json_whitespace").optional() },
    annotations: { readOnlyHint: true },
  }, ({ prompt, compiledPrompt, transformation }) => {
    const ir = analyzePrompt(prompt);
    const failures = validateCompiled(ir, {
      text: compiledPrompt, codecId: "external", codecVersion: "unknown",
      sourceSha256: sha256(prompt), literalIds: ir.literals.map((item) => item.id),
      ...(transformation ? { transformation } : {}),
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
    const report = store.getLatestCalibrationReport(providerFor(store), selectedModel);
    return result(report ? { ...report, diagnostics: diagnoseReport(report) } : null);
  });

  server.registerTool("get_runtime_decision", {
    description: "Predict local routing without calling a provider.",
    inputSchema: { prompt: z.string().min(1), model: z.string().min(1), outputShape: JsonOutputShapeSchema.optional() },
    annotations: { readOnlyHint: true },
  }, async ({ prompt, model, outputShape }) => {
    const router = new RuntimeRouter(adapterFor(store, model, outputShape), store);
    return result((await router.decide(prompt)).decision);
  });

  server.registerTool("explain_fallback", {
    description: "Explain why a prompt would use the original request.",
    inputSchema: { prompt: z.string().min(1), model: z.string().min(1), outputShape: JsonOutputShapeSchema.optional() },
    annotations: { readOnlyHint: true },
  }, async ({ prompt, model, outputShape }) => {
    const router = new RuntimeRouter(adapterFor(store, model, outputShape), store);
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
      responseContract: ResponseContractSchema.optional(),
      outputShape: JsonOutputShapeSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ prompt, model, maxOutputTokens, responseContract, outputShape }) => {
    const selectedModel = model ?? store.getSetting<string>("defaultModel");
    if (!selectedModel) throw new Error("Configure a model first with semantic-ir configure");
    const adapter = adapterFor(store, selectedModel, outputShape);
    try {
      const routed = await new RuntimeRouter(adapter, store).invoke(prompt, {
        scope: "downstream_llm_call", maxOutputTokens,
        ...(responseContract ? { responseContract } : {}),
      });
      return result({
        provider: providerFor(store), model: selectedModel,
        response: routed.outputText, normalization: routed.normalization, usage: routed.response.usage,
        latencyMs: routed.response.latencyMs,
        cost: routed.response.cost ?? adapter.estimateCost(routed.response.usage),
        decision: routed.decision,
        quality: routed.quality,
        outputProtocol: routed.response.structuredOutput?.protocol ?? null,
      });
    } catch (error) {
      if (!(error instanceof ResponseQualityError)) throw error;
      return { ...result({ error: error.message, quality: error.quality, usage: error.usage,
        cost: error.cost, decision: error.decision }), isError: true };
    }
  });

  server.registerTool("calibrate_model", {
    description: "PAID: calls the configured provider. Requires allowSpend=true and explicit budget; OpenRouter USD preflight is estimated.",
    inputSchema: {
      model: z.string().min(1), allowSpend: z.literal(true),
      maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().positive(), maxDurationMs: z.number().int().positive(),
      suite: z.enum(["json-extraction", "redundant-extraction", "synthetic-exact"]).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ model, allowSpend, maxRequests, maxTokens, maxCostUsd, maxDurationMs,
    suite, maxOutputTokens }) =>
    result(await runCalibration({
      store, model, allowSpend, promote: true,
      budget: { maxRequests, maxTokens, maxCostUsd, maxDurationMs },
      ...(suite ? { suite: suite === "redundant-extraction" ? REDUNDANT_EXTRACTION_SUITE :
        suite === "json-extraction" ? JSON_EXTRACTION_SUITE : SYNTHETIC_SUITE } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })));

  server.registerTool("benchmark_codec", {
    description: "PAID: run the synthetic benchmark without promotion. Requires explicit spending budget.",
    inputSchema: {
      model: z.string().min(1), allowSpend: z.literal(true),
      maxRequests: z.number().int().positive(), maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().positive(), maxDurationMs: z.number().int().positive(),
      suite: z.enum(["json-extraction", "redundant-extraction", "synthetic-exact"]).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ model, allowSpend, maxRequests, maxTokens, maxCostUsd, maxDurationMs,
    suite, maxOutputTokens }) =>
    result(await runCalibration({
      store, model, allowSpend, promote: false,
      budget: { maxRequests, maxTokens, maxCostUsd, maxDurationMs },
      ...(suite ? { suite: suite === "redundant-extraction" ? REDUNDANT_EXTRACTION_SUITE :
        suite === "json-extraction" ? JSON_EXTRACTION_SUITE : SYNTHETIC_SUITE } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })));

  await server.connect(new StdioServerTransport());
}
