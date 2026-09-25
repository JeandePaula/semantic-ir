import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSemanticIR } from "@semantic-ir/semantic-ir";
import { analyzePrompt } from "./index.js";

describe("conservative analyzer", () => {
  it("keeps the exact prompt and extracts the Portuguese regression case", () => {
    const prompt = "Altere 7500 para 8500, mas nunca modifique \x60/api/v1/users/{id}\x60.";
    const ir = analyzePrompt(prompt);
    expect(ir.source.text).toBe(prompt);
    expect(ir.analysis.status).toBe("partial");
    expect(ir.literals.map((literal) => literal.text)).toEqual(["7500", "8500", "\x60/api/v1/users/{id}\x60"]);
    expect(ir.constraints).toHaveLength(1);
    expect(ir.constraints[0]?.marker).toBe("nunca");
    expect(ir.constraints[0]?.text).toContain("/api/v1/users/{id}");
  });

  it.each([
    "do not", "don't", "never", "only", "must", "must not", "without",
    "unless", "except", "before", "after", "no", "avoid", "preserve",
    "cannot", "required", "não", "nunca", "apenas", "exceto",
  ])("retains modality marker %s in a source-bound constraint", (marker) => {
    const ir = analyzePrompt("Please " + marker + " change the record.");
    expect(ir.constraints.some((constraint) => constraint.marker.toLowerCase() === marker)).toBe(true);
    for (const constraint of ir.constraints) {
      expect(ir.source.text.slice(constraint.start, constraint.end)).toBe(constraint.text);
    }
  });

  it("does not turn instructions quoted as data into hard constraints", () => {
    const ir = analyzePrompt('Translate "never change this" into French.');
    expect(ir.constraints).toHaveLength(0);
    expect(ir.intent.task).toBe("translation");
  });

  it("does not invent goals, facts, or priorities", () => {
    const ir = analyzePrompt("Hello there");
    expect(ir.intent.task).toBe("unknown");
    expect(ir.goals).toEqual([]);
    expect(ir.facts).toEqual([]);
    expect(ir.priorities).toEqual([]);
    expect(ir.analysis.confidence).toBeLessThan(0.5);
  });

  it("always yields a valid, source-preserving IR for nonempty text", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 200 }), (prompt) => {
      const ir = analyzePrompt(prompt);
      expect(parseSemanticIR(ir)).toEqual(ir);
      expect(ir.source.text).toBe(prompt);
    }), { numRuns: 300 });
  });
});
