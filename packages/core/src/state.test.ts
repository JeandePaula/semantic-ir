import { expect, it } from "vitest";
import { analyzePrompt, applySemanticDelta, createSemanticState } from "./index.js";

it("applies an explicit state delta without changing the original prompt", () => {
  const state = createSemanticState(analyzePrompt("Hello"));
  const next = applySemanticDelta(state, {
    baseStateId: state.id, version: "sir-delta/0.1",
    operations: [{
      op: "add", path: "/goals/G1",
      value: { id: "G1", text: "Reply briefly", confidence: 1,
        provenance: { kind: "user" } },
    }],
  });
  expect(next.ir.source.text).toBe("Hello");
  expect(next.ir.goals[0]?.text).toBe("Reply briefly");
  expect(next.parentStateId).toBe(state.id);
  expect(() => applySemanticDelta(state, {
    baseStateId: state.id, version: "sir-delta/0.1",
    operations: [{ op: "remove", path: "/source/text" }],
  })).toThrow();
});
