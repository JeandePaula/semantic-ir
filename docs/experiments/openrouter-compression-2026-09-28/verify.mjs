import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256, analyzePrompt } from '@semantic-ir/core';
import { prepareResponseProcessor, prepareResponseValidator, compilePrompt, DEFAULT_CODECS } from '@semantic-ir/engine';
import { summarize } from '../openrouter-compression-2026-09-27/summarize.mjs';

const dir = new URL('./', import.meta.url);
const load = file => JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
const casesText = readFileSync(new URL('cases.json', dir), 'utf8');
const { cases } = JSON.parse(casesText);
const report = load('results.json');
assert.equal(report.casesSha256, sha256(casesText));
assert.equal(report.status, 'stopped');
assert.equal(report.stopReason, 'extraction_quality_gate_failed');
for (const c of cases) {
  for (const version of ['normal', 'compact']) {
    assert.equal(c.prompts[version].sha256, sha256(c[version]));
    assert.equal(c.prompts[version].bytes, Buffer.byteLength(c[version]));
  }
  assert.equal(compilePrompt(analyzePrompt(c.normal), DEFAULT_CODECS.find(codec => codec.id === 'json_compact')).text, c.compact);
}
for (const row of report.results) {
  const c = cases.find(c => c.id === row.caseId);
  assert.equal(row.completionStatus, 'completed');
  const processed = prepareResponseProcessor(c.responseContract)(row.response);
  assert.deepEqual(processed.quality, row.quality);
  assert.equal(processed.outputText, row.outputText);
  assert.equal(processed.normalization, row.normalization);
  assert.deepEqual(prepareResponseValidator({ kind: 'exact_json', expected: c.responseContract.expected })(row.response), row.strictQuality);
}
assert.equal(report.results.length, 2);
assert.equal(report.accounting.requests, 2);
assert.equal(report.results[0].response, '"CORAL"');
assert.equal(report.results[0].quality.status, 'verified');
assert.deepEqual(JSON.parse(report.results[1].response), { launch: { color: 'CORAL' } });
assert.equal(report.results[1].quality.status, 'rejected');
const measured = report.results.reduce((sum, row) => sum + row.cost.amountUsd, 0);
assert.ok(Math.abs(measured - 0.00052205) < 1e-12);
assert.ok(Math.abs(measured - report.accounting.measuredCostUsd) < 1e-12);
assert.ok(Math.abs(measured - report.accounting.accountedCostUsd) < 1e-12);
assert.ok(report.accounting.accountedCostUsd <= report.budget.maxCostUsd);
assert.ok(report.budget.maxCostUsd <= report.budget.userAuthorizedCostUsd);
assert.deepEqual(load('summary.json'), JSON.parse(JSON.stringify(summarize(report))));
assert.equal(load('summary.json').groups[0].successfulTaskSavingsPercent, null);
assert.equal(load('summary.json').promoted, false);
assert.deepEqual(report.profileStatusAfterInspection, load('preflight.json').profileStatusAfterInspection);
console.log(JSON.stringify({ verified: true, requests: 2, measuredCostUsd: measured,
  originalCorrect: true, compactCorrect: false, skippedPairs: 4, promoted: false }));
