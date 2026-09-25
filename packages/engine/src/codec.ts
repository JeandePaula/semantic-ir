import { z } from "zod";
import { sha256, type SemanticIR } from "@semantic-ir/semantic-ir";
import type { CodecDefinition, CompiledPrompt } from "@semantic-ir/core";

const token = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/);
const separator = z.string().min(1).max(3).regex(/^[|;:=~,. ]+$/);

export const CodecDefinitionSchema = z.strictObject({
  schemaVersion: z.literal("codec/0.1"),
  id: token,
  strategy: z.enum(["identity", "compact_spacing", "tagged"]),
  aliases: z.record(token, token),
  separator,
  assignment: separator,
  fieldOrder: z.array(z.string()).max(30),
  nesting: z.enum(["nested", "flat"]),
  flattenSingletons: z.boolean(),
  referenceLiterals: z.boolean(),
  referenceEntities: z.boolean(),
  enumAliases: z.record(token, token),
  constraintEncoding: z.enum(["explicit", "symbolic"]),
  relationshipEncoding: z.enum(["explicit", "symbolic"]),
  omitNull: z.boolean(),
  omitDefaults: z.boolean(),
  omitNonsemanticMetadata: z.boolean(),
  deduplicateRepeatedValues: z.boolean(),
});

function definition(id: string, strategy: CodecDefinition["strategy"], sep = ";"): CodecDefinition {
  return {
    schemaVersion: "codec/0.1", id, strategy, aliases: { intent: "I", constraints: "C" },
    separator: sep, assignment: "=", fieldOrder: ["intent", "constraints", "source"],
    nesting: "flat", flattenSingletons: true, referenceLiterals: false,
    referenceEntities: false, enumAliases: {}, constraintEncoding: "explicit",
    relationshipEncoding: "explicit", omitNull: true, omitDefaults: true,
    omitNonsemanticMetadata: true, deduplicateRepeatedValues: false,
  };
}

export const DEFAULT_CODECS: readonly CodecDefinition[] = [
  definition("original", "identity"),
  definition("spacing", "compact_spacing"),
  definition("tagged_semicolon", "tagged", ";"),
  definition("tagged_pipe", "tagged", "|"),
];

function compactSpacing(ir: SemanticIR): string {
  const source = ir.source.text;
  const protectedPositions = new Uint8Array(source.length);
  for (const span of [...ir.literals, ...ir.constraints]) {
    protectedPositions.fill(1, span.start, span.end);
  }
  let output = "";
  for (let index = 0; index < source.length;) {
    if (!protectedPositions[index] && (source[index] === " " || source[index] === "\t")) {
      let end = index + 1;
      while (end < source.length && !protectedPositions[end] &&
             (source[end] === " " || source[end] === "\t")) end++;
      output += " ";
      index = end;
    } else {
      output += source[index] ?? "";
      index++;
    }
  }
  return output;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (needle.length && (from = haystack.indexOf(needle, from)) !== -1) {
    count++;
    from += needle.length;
  }
  return count;
}

export function validateCompiled(ir: SemanticIR, compiled: CompiledPrompt): string[] {
  const failures: string[] = [];
  if (compiled.sourceSha256 !== ir.source.sha256) failures.push("source_checksum");
  const unique = new Set(ir.literals.map((literal) => literal.text));
  for (const text of unique) {
    if (occurrences(compiled.text, text) < occurrences(ir.source.text, text)) {
      failures.push("literal_corruption:" + sha256(text).slice(0, 12));
    }
  }
  for (const constraint of ir.constraints) {
    if (!compiled.text.includes(constraint.text)) failures.push("constraint_loss:" + constraint.id);
  }
  return failures;
}

export function compilePrompt(ir: SemanticIR, input: CodecDefinition): CompiledPrompt {
  const codec = CodecDefinitionSchema.parse(input) as CodecDefinition;
  let text: string;
  switch (codec.strategy) {
    case "identity":
      text = ir.source.text;
      break;
    case "compact_spacing":
      text = compactSpacing(ir);
      break;
    case "tagged": {
      const aliases = codec.aliases;
      const chunks: string[] = [];
      for (const field of codec.fieldOrder) {
        if (field === "intent" && ir.intent.task !== "unknown") {
          chunks.push((aliases.intent ?? "intent") + codec.assignment + ir.intent.task);
        }
        if (field === "constraints" && ir.constraints.length) {
          chunks.push((aliases.constraints ?? "constraints") + codec.assignment +
            ir.constraints.map((item) => item.marker).join(","));
        }
      }
      text = chunks.length ? chunks.join(codec.separator) + "\n" + ir.source.text : ir.source.text;
      break;
    }
  }
  const compiled: CompiledPrompt = {
    text, codecId: codec.id, codecVersion: "0.1.0",
    sourceSha256: ir.source.sha256, literalIds: ir.literals.map((item) => item.id),
  };
  const failures = validateCompiled(ir, compiled);
  if (failures.length) throw new Error("Codec rejected: " + failures.join(", "));
  return compiled;
}

export function mutateElite(elite: readonly CodecDefinition[]): CodecDefinition[] {
  return elite.flatMap((parent, index) => [
    {
      ...parent, id: "evo_" + index + "_tag",
      strategy: "tagged" as const,
      separator: parent.separator === ";" ? "|" : ";",
      aliases: { ...parent.aliases, intent: "T" },
    },
    {
      ...parent, id: "evo_" + index + "_space",
      strategy: "compact_spacing" as const,
      separator: "~",
    },
  ]);
}
