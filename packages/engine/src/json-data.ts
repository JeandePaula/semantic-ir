import { z } from "zod";

export const JsonPathSchema = z.array(z.union([z.string(), z.number().int().safe().nonnegative()])).max(100);

export function checkedInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Arithmetic result exceeds safe JSON integer range");
  }
  return Number(value);
}

export function readJsonPath(data: unknown, parts: readonly (string | number)[]): unknown {
  let value = data;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part) ||
      (Array.isArray(value) && (typeof part !== "number" || part >= value.length))) {
      throw new Error("JSON path does not exist");
    }
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}
