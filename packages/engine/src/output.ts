import { z } from "zod";
import { sha256, type JsonOutputShape, type ModelResponse } from "@semantic-ir/core";
import { parseStrictJson } from "./quality.js";

export const JsonOutputShapeSchema: z.ZodType<JsonOutputShape> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.enum(["string", "number", "integer", "boolean", "null"]) }).strict(),
  z.object({ type: z.literal("array"), items: JsonOutputShapeSchema }).strict(),
  z.object({ type: z.literal("object"), properties: z.record(z.string(), JsonOutputShapeSchema) }).strict(),
]));

// The wrapper permits primitive/array results on endpoints requiring an object at the root.
export const JSON_OUTPUT_INSTRUCTION = "Transport format: return exactly one JSON object with the sole key \"value\". " +
  "Put the requested answer under that key, matching the supplied schema. Do not copy source containers unless requested. " +
  "No Markdown or commentary. The application unwraps value to produce the requested final answer.";

export function matchesOutputShape(value: unknown, shape: JsonOutputShape): boolean {
  switch (shape.type) {
    case "null": return value === null;
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "array": return Array.isArray(value) && value.every(item => matchesOutputShape(item, shape.items));
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === Object.keys(shape.properties).length &&
      Object.entries(shape.properties).every(([key, child]) => Object.hasOwn(value, key) &&
        matchesOutputShape((value as Record<string, unknown>)[key], child));
  }
}

export function prepareJsonOutput(input: unknown) {
  // Bound recursion before Zod walks SDK inputs; cycles cannot escape this finite traversal.
  let nodes = 0;
  const bound = (value: unknown, depth: number): void => {
    if (++nodes > 256 || depth > 16) throw new Error("Output shape exceeds 256 nodes or 16 levels");
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.type === "array") bound(object.items, depth + 1);
    if (object.type === "object" && object.properties && typeof object.properties === "object") {
      for (const child of Object.values(object.properties)) bound(child, depth + 1);
    }
  };
  bound(input, 0);
  const shape = JsonOutputShapeSchema.parse(input);
  const compile = (node: JsonOutputShape): Record<string, unknown> => {
    if (node.type === "array") return { type: "array", items: compile(node.items) };
    if (node.type === "object") return { type: "object",
      properties: Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, compile(child)])),
      required: Object.keys(node.properties), additionalProperties: false };
    return { type: node.type };
  };
  const shapeSha256 = sha256(JSON.stringify(shape));
  const responseFormat = { type: "json_schema" as const, json_schema: { name: "semantic_ir_response", strict: true,
    schema: { type: "object", properties: { value: compile(shape) }, required: ["value"], additionalProperties: false } } };
  const decode = (text: string): NonNullable<ModelResponse["structuredOutput"]> => {
    const base = { protocol: "json-envelope/1" as const, shapeSha256 };
    let parsed: unknown;
    try { parsed = parseStrictJson(text); } catch {
      return { ...base, status: "invalid", outputText: null, reasons: ["invalid_or_ambiguous_json_envelope"] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "value")) {
      return { ...base, status: "invalid", outputText: null, reasons: ["invalid_json_envelope"] };
    }
    const value = (parsed as { value: unknown }).value;
    if (!matchesOutputShape(value, shape)) {
      return { ...base, status: "invalid", outputText: null, reasons: ["output_shape_mismatch"] };
    }
    return { ...base, status: "valid", outputText: JSON.stringify(value), reasons: [] };
  };
  return { shape, shapeSha256, responseFormat, decode };
}

/** A failed transport contract cannot fall back to raw text and bypass its validation. */
export function modelOutputText(response: ModelResponse): string | null {
  return response.structuredOutput ? response.structuredOutput.status === "valid"
    ? response.structuredOutput.outputText : null : response.text;
}
