import { hashCanonicalIR, parseSemanticIR } from "@semantic-ir/semantic-ir";
import type { Claim, SemanticIR } from "@semantic-ir/semantic-ir";
import type { SemanticDelta, SemanticState } from "./contracts.js";

export function createSemanticState(ir: SemanticIR, parentStateId: string | null = null): SemanticState {
  const parsed = parseSemanticIR(ir);
  return { id: hashCanonicalIR(parsed), version: "sir-state/0.1", ir: parsed, parentStateId };
}

/** Local prototype: only user-provided goals/preferences can be updated. */
export function applySemanticDelta(state: SemanticState, delta: SemanticDelta): SemanticState {
  if (delta.baseStateId !== state.id) throw new Error("Semantic state version mismatch");
  if (delta.version !== "sir-delta/0.1") throw new Error("Unsupported semantic delta version");
  const next: SemanticIR = structuredClone(state.ir);
  for (const operation of delta.operations) {
    const match = /^\/(goals|preferences)\/([A-Za-z0-9_-]+)$/.exec(operation.path);
    if (!match) throw new Error("Delta path is not allowed");
    const collection = match[1] as "goals" | "preferences";
    const id = match[2] ?? "";
    const items = next[collection];
    const index = items.findIndex((item) => item.id === id);
    if (operation.op === "remove") {
      if (index < 0) throw new Error("Delta target does not exist");
      items.splice(index, 1);
      continue;
    }
    const claim = operation.value as Claim;
    if (!claim || claim.id !== id || claim.provenance?.kind !== "user") {
      throw new Error("Delta claim must be explicitly user-sourced");
    }
    if (operation.op === "add") {
      if (index >= 0) throw new Error("Delta target already exists");
      items.push(claim);
    } else if (operation.op === "replace") {
      if (index < 0) throw new Error("Delta target does not exist");
      items[index] = claim;
    }
  }
  return createSemanticState(parseSemanticIR(next), state.id);
}
