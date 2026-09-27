import { analyzePrompt } from "@semantic-ir/core";
import type { CodecDefinition } from "@semantic-ir/core";
import { compilePrompt, DEFAULT_CODECS } from "./codec.js";

export const MINIMUM_SAVINGS_BYTES = 128;

/** Local screening only. Bytes are deliberately not labeled as tokens or dollars. */
export function auditPrompt(prompt: string, codecs: readonly CodecDefinition[] = DEFAULT_CODECS,
  minimumSavingsBytes = MINIMUM_SAVINGS_BYTES) {
  const ir = analyzePrompt(prompt);
  const originalBytes = Buffer.byteLength(prompt, "utf8");
  const seen = new Set<string>();
  const candidates = codecs.map((codec) => {
    try {
      const compiled = compilePrompt(ir, codec);
      const compiledBytes = Buffer.byteLength(compiled.text, "utf8");
      const savedBytes = originalBytes - compiledBytes;
      const reason = savedBytes <= 0 ? "no_size_reduction" :
        savedBytes < minimumSavingsBytes ? "reduction_too_small" :
          seen.has(compiled.text) ? "duplicate_candidate" : null;
      if (reason === null) seen.add(compiled.text);
      return { codecId: codec.id, originalBytes, compiledBytes, savedBytes,
        reductionPercent: 100 * savedBytes / originalBytes, eligible: reason === null, reason };
    } catch {
      return { codecId: codec.id, originalBytes, compiledBytes: null, savedBytes: 0,
        reductionPercent: 0, eligible: false, reason: "semantic_verification_failed" };
    }
  });
  return {
    taskClass: ir.intent.task, originalBytes, minimumSavingsBytes, candidates,
    recommendedCodecId: candidates.filter((item) => item.eligible)
      .sort((a, b) => b.savedBytes - a.savedBytes)[0]?.codecId ?? null,
    tokenSavings: "unavailable", costSavings: "unavailable", providerCalls: 0,
  };
}
