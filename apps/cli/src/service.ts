import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { BenchmarkSuite, CalibrationBudget, TaskClass } from "@semantic-ir/core";
import {
  DEFAULT_CODECS, EvolutionaryOptimizer, OpenAIAdapter,
  REDUNDANT_EXTRACTION_SUITE, SqliteStore, SYNTHETIC_SUITE, type OpenAIPrice,
  type OptimizationReport,
} from "@semantic-ir/engine";

export type ProviderId = "openai" | "openrouter";

export function providerFor(store: SqliteStore): ProviderId {
  return store.getSetting<ProviderId>("defaultProvider") === "openrouter" ? "openrouter" : "openai";
}

export function credentialPath(provider: ProviderId): string {
  const variable = provider === "openrouter" ? "OPENROUTER_API_KEY_FILE" : "OPENAI_API_KEY_FILE";
  return process.env[variable] ?? join(homedir(), ".config", "semantic-ir", provider + ".key");
}

export function saveProviderKey(provider: ProviderId, key: string): string {
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new Error("Invalid API key input");
  const path = credentialPath(provider);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

export function providerKey(provider: ProviderId): string {
  const variable = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
  if (process.env[variable]) return process.env[variable] ?? "";
  const path = credentialPath(provider);
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new Error("Credential file permissions must be 0600: " + path);
    }
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

export function databasePath(): string {
  return process.env.SEMANTIC_IR_DB ?? join(homedir(), ".semantic-ir", "semantic-ir.sqlite");
}

export function openStore(): SqliteStore {
  return new SqliteStore(databasePath());
}

export function adapterFor(store: SqliteStore, model: string): OpenAIAdapter {
  const provider = providerFor(store);
  const price = store.getSetting<OpenAIPrice>("price:" + provider + ":" + model) ??
    (provider === "openai" ? store.getSetting<OpenAIPrice>("price:" + model) : null);
  return new OpenAIAdapter(model, { provider, apiKey: providerKey(provider), price });
}

export async function runCalibration(options: {
  store: SqliteStore;
  model: string;
  budget: CalibrationBudget;
  taskClass?: TaskClass;
  suite?: BenchmarkSuite;
  allowSpend: boolean;
  promote: boolean;
  maxOutputTokens?: number;
}): Promise<OptimizationReport> {
  if (!options.allowSpend) throw new Error("Calibration requires explicit allowSpend=true");
  let adapter = adapterFor(options.store, options.model);
  const provider = providerFor(options.store);
  if (provider === "openrouter") {
    const price = await adapter.discoverOpenRouterPrice();
    options.store.setSetting("price:openrouter:" + options.model, price);
    adapter = adapterFor(options.store, options.model);
  }
  if (!adapter.getCapabilities().tokenCounting && provider !== "openrouter") {
    throw new Error("Calibration unavailable: provider has no budget preflight");
  }
  const targetStore = options.promote ? options.store : new SqliteStore(":memory:");
  try {
    const optimizer = new EvolutionaryOptimizer(adapter, targetStore);
    await optimizer.optimize({
      fingerprint: await adapter.getModelFingerprint(),
      taskClass: options.taskClass ?? "extraction",
      suite: options.suite ?? (provider === "openrouter" ? REDUNDANT_EXTRACTION_SUITE : SYNTHETIC_SUITE),
      seeds: DEFAULT_CODECS.map((definition) => ({
        id: definition.id, version: "0.1.0", definition,
        definitionSha256: "", status: "experimental", parentVersion: null,
      })),
      budget: options.budget,
      maxOutputTokens: options.maxOutputTokens ?? (provider === "openrouter" ? 256 : 64),
    });
    if (!optimizer.lastReport) throw new Error("Optimizer did not produce a report");
    const report = { ...optimizer.lastReport,
      promoted: options.promote && optimizer.lastReport.selectedCodecId !== null };
    options.store.saveCalibrationReport(provider, options.model,
      options.taskClass ?? "extraction", report);
    return report;
  } finally {
    if (!options.promote) targetStore.close();
  }
}
