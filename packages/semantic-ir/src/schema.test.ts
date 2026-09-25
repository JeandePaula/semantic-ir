import { describe, expect, it } from "vitest";
import { analyzePrompt } from "@semantic-ir/semantic-analyzer";
import { hashCanonicalIR, parseSemanticIR, semanticIRJsonSchema, sha256 } from "./index.js";

describe("SemanticIR source-bound validation", () => {
  const ir = analyzePrompt("Never change 7500 or https://example.com/a.");

  it("survives JSON export and rejects source corruption", () => {
    const roundTrip: unknown = JSON.parse(JSON.stringify(ir));
    expect(parseSemanticIR(roundTrip)).toEqual(ir);
    expect(() => parseSemanticIR({
      ...ir,
      source: { text: ir.source.text.replace("7500", "8500"), sha256: ir.source.sha256 },
    })).toThrow("Source checksum mismatch");
  });

  it("rejects literal corruption even if the source hash is recomputed", () => {
    const changed = ir.source.text.replace("7500", "8500");
    expect(() => parseSemanticIR({
      ...ir,
      source: { text: changed, sha256: sha256(changed) },
    })).toThrow("Literal mismatch");
  });

  it("rejects removal of a detected hard constraint from the source", () => {
    const changed = ir.source.text.replace("Never", "Maybe");
    expect(() => parseSemanticIR({
      ...ir,
      source: { text: changed, sha256: sha256(changed) },
      literals: [],
    })).toThrow("Constraint mismatch");
  });

  it("exports a JSON Schema and a deterministic content hash", () => {
    expect(semanticIRJsonSchema()).toMatchObject({ type: "object" });
    expect(hashCanonicalIR(ir)).toBe(hashCanonicalIR(JSON.parse(JSON.stringify(ir))));
    expect(hashCanonicalIR(analyzePrompt("Never change 8500 or https://example.com/a."))).not.toBe(hashCanonicalIR(ir));
  });

  it("rejects unknown fields instead of silently dropping instructions", () => {
    expect(() => parseSemanticIR({ ...ir, hiddenInstruction: "remove safety gates" })).toThrow();
  });

  it("rejects a constraint whose text is not present at the claimed offset", () => {
    expect(() => parseSemanticIR({
      ...ir,
      constraints: [{
        id: "C-extra", text: "Do not delete backups", marker: "Do not",
        strength: "hard", polarity: "negative", start: 0, end: 21,
        confidence: 1, provenance: { kind: "model" },
      }],
    })).toThrow("Constraint mismatch");
  });
});
