import { createHash } from "node:crypto";
import { z } from "zod";

export const SIR_VERSION = "sir/0.1" as const;

export const TaskClassSchema = z.enum([
  "unknown", "coding", "debugging", "code_review", "reasoning", "math",
  "extraction", "summarization", "conversation", "creative_writing",
  "multilingual", "translation", "rag", "long_context", "tool_use",
  "structured_output", "agent_communication",
]);

export const ProvenanceSchema = z.strictObject({
  kind: z.enum(["source_text", "heuristic", "user", "model"]),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  method: z.string().optional(),
});

export const ClaimSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  provenance: ProvenanceSchema,
});

export const IntentSchema = z.strictObject({
  task: TaskClassSchema,
  goal: z.string().optional(),
  confidence: z.number().min(0).max(1),
  provenance: ProvenanceSchema,
});

export const ConstraintSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  marker: z.string().min(1),
  strength: z.enum(["hard", "soft"]),
  polarity: z.enum(["negative", "positive", "restrictive", "temporal"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  provenance: ProvenanceSchema,
});

export const PrioritySchema = z.strictObject({
  id: z.string().min(1),
  target: z.string().min(1),
  weight: z.number().min(0).max(1),
  provenance: ProvenanceSchema,
});

export const LiteralSpanSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    "code", "quoted", "url", "uuid", "hash", "path", "filename",
    "regex", "json", "sql", "xml", "yaml", "identifier", "equation",
    "date", "time", "money", "percentage", "number",
  ]),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const SemanticIRSchema = z.strictObject({
  version: z.literal(SIR_VERSION),
  source: z.strictObject({
    text: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    locale: z.string().optional(),
  }),
  intent: IntentSchema,
  goals: z.array(ClaimSchema),
  facts: z.array(ClaimSchema),
  entities: z.array(ClaimSchema),
  assumptions: z.array(ClaimSchema),
  constraints: z.array(ConstraintSchema),
  prohibitions: z.array(ClaimSchema),
  preferences: z.array(ClaimSchema),
  priorities: z.array(PrioritySchema),
  dependencies: z.array(ClaimSchema),
  relationships: z.array(ClaimSchema),
  contextReferences: z.array(ClaimSchema),
  uncertainty: z.array(ClaimSchema),
  requestedOutput: ClaimSchema.optional(),
  formattingRequirements: z.array(ClaimSchema),
  toolRequirements: z.array(ClaimSchema),
  literals: z.array(LiteralSpanSchema),
  analysis: z.strictObject({
    status: z.literal("partial"),
    analyzerVersion: z.string().min(1),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()),
  }),
});

export type TaskClass = z.infer<typeof TaskClassSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type LiteralSpan = z.infer<typeof LiteralSpanSchema>;
export type SemanticIR = z.infer<typeof SemanticIRSchema>;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Schema validity plus source-bound invariants that JSON Schema cannot express. */
export function parseSemanticIR(input: unknown): SemanticIR {
  const ir = SemanticIRSchema.parse(input);
  const source = ir.source.text;
  if (sha256(source) !== ir.source.sha256) {
    throw new Error("Source checksum mismatch");
  }
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const literal of ir.literals) {
    if (ids.has(literal.id)) throw new Error(`Duplicate literal ID: ${literal.id}`);
    ids.add(literal.id);
    if (literal.start < previousEnd || literal.end > source.length || literal.start >= literal.end) {
      throw new Error(`Invalid or overlapping literal span: ${literal.id}`);
    }
    if (source.slice(literal.start, literal.end) !== literal.text || sha256(literal.text) !== literal.sha256) {
      throw new Error(`Literal mismatch: ${literal.id}`);
    }
    previousEnd = literal.end;
  }
  const constraintIds = new Set<string>();
  for (const constraint of ir.constraints) {
    if (constraintIds.has(constraint.id)) throw new Error("Duplicate constraint ID: " + constraint.id);
    constraintIds.add(constraint.id);
    if (constraint.start >= constraint.end || constraint.end > source.length ||
        source.slice(constraint.start, constraint.end) !== constraint.text) {
      throw new Error(`Constraint mismatch: ${constraint.id}`);
    }
    if (!constraint.text.toLocaleLowerCase().includes(constraint.marker.toLocaleLowerCase())) {
      throw new Error(`Constraint marker mismatch: ${constraint.id}`);
    }
  }
  return ir;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/** Content hash, not a claim that differently worded prompts are equivalent. */
export function hashCanonicalIR(input: unknown): string {
  return sha256(JSON.stringify(canonicalize(parseSemanticIR(input))));
}

export function semanticIRJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SemanticIRSchema) as Record<string, unknown>;
}
