import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

function decimalKey(token: string): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  if ((parts[4]?.length ?? 0) > 8) throw new Error("JSON exponent out of range");
  let digits = (parts[2]! + (parts[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  let exponent = Number(parts[4] ?? 0) - (parts[3]?.length ?? 0);
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; }
  return parts[1] + digits + "e" + exponent;
}

/** Reject ambiguous JSON and unsafe numeric integers instead of silently rounding them. */
export function parseStrictJson(text: string): unknown {
  let position = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[position] ?? "!")) position++; };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === "\\") position++;
      else if (char === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (depth: number): unknown => {
    if (depth > 100) throw new Error("JSON nesting exceeds 100");
    whitespace();
    const char = text[position];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      position++;
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = [];
      const keys = new Set<string>();
      const end = char === "{" ? "}" : "]";
      whitespace();
      if (text[position] === end) { position++; return char === "{" ? object : array; }
      while (true) {
        whitespace();
        if (char === "{") {
          if (text[position] !== '"') throw new Error("Expected JSON key");
          const key = string();
          if (keys.has(key)) throw new Error("Duplicate JSON key");
          keys.add(key);
          whitespace();
          if (text[position++] !== ":") throw new Error("Expected JSON colon");
          object[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace();
        const separator = text[position++];
        if (separator === end) break;
        if (separator !== ",") throw new Error("Expected JSON separator");
      }
      return char === "{" ? object : array;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(position))?.[0];
    if (!token) throw new Error("Expected JSON value");
    position += token.length;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === "number" && (!Number.isFinite(parsed) ||
      (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))) {
      throw new Error("Unsafe JSON number; encode large integers as strings");
    }
    if (typeof parsed === "number" && decimalKey(token) !== decimalKey(String(parsed))) {
      throw new Error("JSON number loses precision; encode exact decimals as strings");
    }
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (position !== text.length) throw new Error("Trailing JSON content");
  return parsed;
}

export const ResponseContractSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact_text"), expected: z.string() }).strict(),
  z.object({ kind: z.literal("exact_json"), expected: z.string(),
    normalization: z.literal("single_json_fence").optional() }).strict(),
]);
export type ResponseContract = z.infer<typeof ResponseContractSchema>;
export interface QualityResult {
  readonly status: "verified" | "unverified" | "rejected";
  readonly validator: ResponseContract["kind"] | null;
  readonly reasons: readonly string[];
}

/** Prepare before inference: malformed contracts must never cause a paid call. */
export function prepareResponseProcessor(input?: ResponseContract): (text: string) => {
  outputText: string; normalization: "single_json_fence" | null; quality: QualityResult;
} {
  if (!input) return (outputText) => ({ outputText, normalization: null,
    quality: { status: "unverified", validator: null, reasons: ["no_response_contract"] } });
  const contract = ResponseContractSchema.parse(input);
  const expected = contract.kind === "exact_json" ? parseStrictJson(contract.expected) : contract.expected;
  return (text) => {
    // Only a whole, single JSON fence may be unwrapped. Never repair values or trailing prose.
    const fenced = contract.kind === "exact_json" && contract.normalization === "single_json_fence"
      ? /^\s*```json\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text) : null;
    const outputText = fenced?.[1] ?? text;
    const normalization = fenced ? "single_json_fence" as const : null;
    let matches = false;
    try {
      matches = contract.kind === "exact_json" ? isDeepStrictEqual(parseStrictJson(outputText), expected) : text === expected;
    } catch {
      return { outputText, normalization,
        quality: { status: "rejected", validator: contract.kind, reasons: ["invalid_or_ambiguous_json"] } };
    }
    return { outputText, normalization, quality: { status: matches ? "verified" : "rejected", validator: contract.kind,
      reasons: matches ? [] : ["answer_mismatch"] } };
  };
}

export function prepareResponseValidator(input?: ResponseContract): (text: string) => QualityResult {
  const process = prepareResponseProcessor(input);
  return text => process(text).quality;
}
