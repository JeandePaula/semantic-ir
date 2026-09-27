import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzePrompt } from "@semantic-ir/core";
import { auditPrompt, compilePrompt, DEFAULT_CODECS, JSON_EXTRACTION_SUITE,
  REDUNDANT_EXTRACTION_SUITE, SYNTHETIC_SUITE } from "@semantic-ir/engine";

const legacyCodecs = DEFAULT_CODECS.filter((codec) => codec.strategy !== "compact_json");
const suites = [JSON_EXTRACTION_SUITE, REDUNDANT_EXTRACTION_SUITE, SYNTHETIC_SUITE].map((suite) => {
  const cases = suite.cases.filter((item) => item.oracleId === "exact").map((item) => {
    const ir = analyzePrompt(item.prompt);
    const originalBytes = Buffer.byteLength(item.prompt);
    const previousBestBytes = Math.min(originalBytes, ...legacyCodecs.map((codec) =>
      Buffer.byteLength(compilePrompt(ir, codec).text)));
    const audit = auditPrompt(item.prompt);
    const candidate = audit.candidates.find((entry) => entry.codecId === audit.recommendedCodecId);
    return { caseId: item.id, originalBytes, previousBestBytes,
      currentBestBytes: candidate?.compiledBytes ?? originalBytes, codecId: candidate?.codecId ?? null };
  });
  const originalBytes = cases.reduce((sum, item) => sum + item.originalBytes, 0);
  const previousBestBytes = cases.reduce((sum, item) => sum + item.previousBestBytes, 0);
  const currentBestBytes = cases.reduce((sum, item) => sum + item.currentBestBytes, 0);
  return { suite: suite.id, cases, originalBytes, previousBestBytes, currentBestBytes,
    reductionPercent: 100 * (1 - currentBestBytes / originalBytes) };
});
const report = { kind: "offline_byte_comparison", providerCalls: 0,
  tokenSavings: "unavailable", costSavings: "unavailable", suites };
const json = JSON.stringify(report, null, 2) + "\n";
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1) {
  const path = process.argv[outIndex + 1];
  if (!path) throw new Error("Missing --out path");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, json);
}
process.stdout.write(json);
