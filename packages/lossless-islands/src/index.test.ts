import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { detectLiteralSpans, verifyLiteralSpans } from "./index.js";

describe("lossless islands", () => {
  it.each([
    ["7500", "number"],
    ["$1,250.50", "money"],
    ["99.8%", "percentage"],
    ["2026-09-24", "date"],
    ["14:30", "time"],
    ["https://example.com/a?q=1", "url"],
    ["123e4567-e89b-42d3-a456-426614174000", "uuid"],
    ["/api/v1/users/{id}", "path"],
    ["src/index.ts", "path"],
    ["\x60const x = 1;\x60", "code"],
    ['{"id": 7}', "json"],
    ["SELECT id FROM users;", "sql"],
    ["<root><id>7</id></root>", "xml"],
  ] as const)("preserves %s as %s", (value, kind) => {
    const source = "Keep " + value + " unchanged";
    const spans = detectLiteralSpans(source);
    expect(spans.some((span) => span.text === value && span.kind === kind)).toBe(true);
    expect(verifyLiteralSpans(source, spans)).toBe(true);
  });

  it("keeps code fences intact instead of selecting numbers within them", () => {
    const source = "Keep \x60\x60\x60json\n{\"id\": 7}\n\x60\x60\x60 unchanged";
    const spans = detectLiteralSpans(source);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe("json");
    expect(spans[0]?.text).toContain('"id": 7');
  });

  it("uses UTF-16 offsets and detects tampering", () => {
    const source = "😀 change 7500";
    const spans = detectLiteralSpans(source);
    expect(spans[0]?.start).toBe(source.indexOf("7500"));
    expect(verifyLiteralSpans(source.replace("7500", "8500"), spans)).toBe(false);
  });

  it.each([
    ["number", "7500", "8500"],
    ["URL", "https://example.com/a", "https://example.com/b"],
    ["code", "\x60const x = 1;\x60", "\x60const x = 2;\x60"],
  ])("rejects %s corruption", (_label, original, changed) => {
    const prompt = "Keep " + original + " unchanged";
    expect(verifyLiteralSpans(prompt.replace(original, changed), detectLiteralSpans(prompt))).toBe(false);
  });

  it("keeps every emitted span ordered and exact for varied text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (source) => {
      const spans = detectLiteralSpans(source);
      expect(verifyLiteralSpans(source, spans)).toBe(true);
      expect(spans.map((span) => span.text)).toEqual(
        spans.map((span) => source.slice(span.start, span.end)),
      );
    }), { numRuns: 500 });
  });
});
