import { z } from "zod";
import { sha256 } from "@semantic-ir/core";
import { JsonPathSchema as path, readJsonPath, checkedInteger } from "./json-data.js";
import { parseStrictJson } from "./quality.js";

const predicate = z.discriminatedUnion("op", [
  z.object({ op: z.literal("eq"), path,
    value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ op: z.enum(["gt", "gte", "lt", "lte"]), path, value: z.number().int().safe() }).strict(),
]);
export const JsonQuerySchema = z.object({
  kind: z.literal("json_query_v1"), data: z.json(), path,
  steps: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("filter"), all: z.array(predicate).min(1).max(32) }).strict(),
    z.object({ op: z.literal("sort"), by: z.array(z.object({ path,
      direction: z.enum(["asc", "desc"]), type: z.enum(["string", "integer"]) }).strict()).min(1).max(16) }).strict(),
    z.object({ op: z.literal("project"), path }).strict(),
    z.object({ op: z.literal("sum"), path }).strict(),
    z.object({ op: z.literal("count") }).strict(),
  ])).min(1).max(32),
}).strict();
type JsonQuery = z.infer<typeof JsonQuerySchema>;

function prepare(input: unknown): JsonQuery {
  const task = JsonQuerySchema.parse(input);
  parseStrictJson(JSON.stringify(task));
  if (!Array.isArray(readJsonPath(task.data, task.path))) throw new Error("Query input must be an array");
  const terminal = task.steps.findIndex(step => step.op === "sum" || step.op === "count");
  if (terminal !== -1 && terminal !== task.steps.length - 1) throw new Error("No step may follow a scalar result");
  return task;
}

/** Compile an explicit data-only program. This does not translate natural-language rules. */
export function compileJsonQuery(input: unknown) {
  const task = prepare(input);
  const { data, ...program } = task;
  return { version: "json-query-plan/1" as const, target: "local" as const,
    programSha256: sha256(JSON.stringify(program)), dataSha256: sha256(JSON.stringify(data)),
    sourcePath: task.path,
    steps: task.steps.map((step, index) => ({ index, inputType: "array" as const,
      outputType: step.op === "sum" || step.op === "count" ? "integer" as const : "array" as const,
      instruction: step })),
    providerCalls: 0,
    validation: "Schema, source shape and operator order checked; field types and paths checked during execution",
  };
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Query requires a safe integer");
  return value;
}

export function executeJsonQuery(input: unknown): unknown {
  const task = prepare(input);
  let rows = [...readJsonPath(task.data, task.path) as unknown[]];
  for (const step of task.steps) {
    switch (step.op) {
      case "filter":
        rows = rows.filter(row => step.all.map(condition => {
          // Check every predicate, even if an earlier one is false: no silent missing fields.
          const value = readJsonPath(row, condition.path);
          if (condition.op === "eq") return value === condition.value;
          const number = integer(value);
          switch (condition.op) {
            case "gt": return number > condition.value;
            case "gte": return number >= condition.value;
            case "lt": return number < condition.value;
            case "lte": return number <= condition.value;
          }
        }).every(Boolean));
        break;
      case "sort": {
        // Precompute and validate all keys, including singleton arrays. Stable ordinal ties.
        const keyed = rows.map((row, index) => ({ row, index, keys: step.by.map(key => {
          const value = readJsonPath(row, key.path);
          if (key.type === "integer") return integer(value);
          if (typeof value !== "string") throw new Error("Query sort requires a string");
          return value;
        }) }));
        keyed.sort((a, b) => {
          for (const [index, key] of step.by.entries()) {
            const left = a.keys[index]!;
            const right = b.keys[index]!;
            const comparison = left < right ? -1 : left > right ? 1 : 0;
            if (comparison) return key.direction === "asc" ? comparison : -comparison;
          }
          return a.index - b.index;
        });
        rows = keyed.map(item => item.row);
        break;
      }
      case "project": rows = rows.map(row => readJsonPath(row, step.path)); break;
      case "sum": return checkedInteger(rows.reduce<bigint>((sum, row) => sum + BigInt(integer(readJsonPath(row, step.path))), 0n));
      case "count": return rows.length;
    }
  }
  return rows;
}
