import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { executeLocalTask, prepareResponseValidator, JSON_EXTRACTION_SUITE } from '@semantic-ir/engine';
import { sha256 } from '@semantic-ir/core';

// Offline only. Expected output predates this implementation and is never regenerated here.
const dir = new URL('../docs/experiments/complex-json/', import.meta.url);
const inputText = readFileSync(new URL('input.json', dir), 'utf8');
const expectedText = readFileSync(new URL('expected.json', dir), 'utf8');
const data = JSON.parse(inputText);
const expected = JSON.parse(expectedText);
const receipt = executeLocalTask({ kind: 'order_allocation_v1', data });
assert.deepEqual(receipt.result, expected);
const verify = prepareResponseValidator({ kind: 'exact_json', expected: expectedText });
assert.equal(verify(JSON.stringify(receipt.result)).status, 'verified');

// Permutations are metamorphic checks, not additional independent workload families.
for (let shift = 0; shift < data.orders.length; shift++) {
  const orders = data.orders.slice(shift).concat(data.orders.slice(0, shift)).reverse();
  assert.deepEqual(executeLocalTask({ kind: 'order_allocation_v1', data: { ...data, orders } }).result, expected);
}

const extraction = JSON_EXTRACTION_SUITE.cases.map(testCase => {
  const text = /```json\n([\s\S]*?)\n```/.exec(testCase.prompt)?.[1];
  assert.ok(text);
  const actual = executeLocalTask({ kind: 'json_select_v1', data: JSON.parse(text), path: ['launch', 'color'] });
  assert.equal(actual.result, testCase.expectedOutput);
  return { caseId: testCase.id, correct: true, providerCalls: actual.usage.providerCalls };
});
const rejectedHistorical = ['normal-1.json', 'normal-2.txt', 'compact-1.json', 'compact-2.json'].map(file => {
  const quality = verify(readFileSync(new URL(file, dir), 'utf8'));
  assert.equal(quality.status, 'rejected');
  return { file, ...quality };
});
const history = JSON.parse(readFileSync(new URL('summary.json', dir), 'utf8'));
const historicalComparison = ['normal', 'compact'].map(version => {
  const runs = history.runs.filter(run => run.version === version);
  return { version, returnedCalls: runs.length, fullyCorrect: runs.filter(r => r.metrics.allCorrect).length,
    inputTokensPerCall: runs[0].usage.inputTokens,
    totalTokens: runs.reduce((sum, r) => sum + r.usage.totalTokens, 0),
    measuredCostUsd: Number(runs.reduce((sum, r) => sum + r.costUsd, 0).toFixed(8)) };
});
const report = {
  kind: 'local_contract_execution', version: 1,
  method: 'Versioned deterministic rules, not natural-language prompt compression or a new model trial.',
  providerCalls: 0, downstreamTokens: 0, downstreamCostUsd: 0,
  complex: { reference: 'docs/experiments/complex-json/expected.json', exactMatch: true,
    inputFileSha256: sha256(inputText), expectedFileSha256: sha256(expectedText),
    resultSha256: receipt.verification.resultSha256, eventOrderPermutationsPassed: data.orders.length,
    approvedCount: expected.approved.length, rejectedCount: expected.rejected.length },
  extraction, rejectedHistorical, historicalComparison,
  downstreamTokenReductionPercent: 100,
  limitations: [
    'Eliminates downstream inference only for the explicit supported structured contracts.',
    'Input rules were formalized in code; equivalence to arbitrary prose is not automatic.',
    'Host reasoning/tool-result tokens, development effort, CPU and electricity are not included.',
    'Historical LLM runs failed; this is an architecture comparison, not equal-quality model compression.',
    'No new paid requests and no changes to historical evidence or model profiles.',
  ],
};
if (process.argv.includes('--write')) {
  writeFileSync(new URL('local-result.json', dir), JSON.stringify(receipt.result, null, 2) + '\n');
  writeFileSync(new URL('../docs/reports/local-execution.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
