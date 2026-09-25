import { homedir } from "node:os";
import { join } from "node:path";
import type { BenchmarkSuite, CalibrationBudget, TaskClass } from "@semantic-ir/core";
import {
  DEFAULT_CODECS, EvolutionaryOptimizer, OpenAIAdapter,
  SqliteStore, SYNTHETIC_SUITE, type OpenAIPrice,
  type OptimizationReport,
} from "@semantic-ir/engine";

export function databasePath(): string {
  return process.env.SEMANTIC_IR_DB ?? join(homedir(), ".semantic-ir", "semantic-ir.sqlite");
}

export function openStore(): SqliteStore {
  return new SqliteStore(databasePath());
}

export function adapterFor(store: SqliteStore, model: string): OpenAIAdapter {
  return new OpenAIAdapter(model, { price: store.getSetting<OpenAIPrice>("price:" + model) });
}

export async function runCalibration(options: {
  store: SqliteStore;
  model: string;
  budget: CalibrationBudget;
  taskClass?: TaskClass;
  suite?: BenchmarkSuite;
  allowSpend: boolean;
  promote: boolean;
}): Promise<OptimizationReport> {
  if (!options.allowSpend) throw new Error("Calibration requires explicit allowSpend=true");
  const adapter = adapterFor(options.store, options.model);
  const targetStore = options.promote ? options.store : new SqliteStore(":memory:");
  try {
    const optimizer = new EvolutionaryOptimizer(adapter, targetStore);
    await optimizer.optimize({
      fingerprint: await adapter.getModelFingerprint(),
      taskClass: options.taskClass ?? "extraction",
      suite: options.suite ?? SYNTHETIC_SUITE,
      seeds: DEFAULT_CODECS.map((definition) => ({
        id: definition.id, version: "0.1.0", definition,
        definitionSha256: "", status: "experimental", parentVersion: null,
      })),
      budget: options.budget,
    });
    if (!optimizer.lastReport) throw new Error("Optimizer did not produce a report");
    return optimizer.lastReport;
  } finally {
    if (!options.promote) targetStore.close();
  }
}
