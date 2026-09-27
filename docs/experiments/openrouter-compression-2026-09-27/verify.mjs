import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256 } from '@semantic-ir/core';
import { prepareResponseValidator } from '@semantic-ir/engine';
import { summarize } from './summarize.mjs';

const dir = new URL('./', import.meta.url);
const load = file => JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
const casesText = readFileSync(new URL('cases.json', dir), 'utf8');
const { cases } = JSON.parse(casesText);
const report = load('results.json');
assert.ok(['completed', 'stopped', 'failed'].includes(report.status), 'Experiment still running');
assert.equal(report.casesSha256, sha256(casesText));
for (const c of cases) {
  for (const version of ['normal', 'compact']) {
    assert.equal(c.prompts[version].sha256, sha256(c[version]));
    assert.equal(c.prompts[version].bytes, Buffer.byteLength(c[version]));
  }
}
const byId = new Map(cases.map(c => [c.id, c]));
let measured = 0;
const formattingDiagnostics = [];
const keys = new Set();
for (const row of report.results) {
  const key = [row.caseId, row.repetition, row.version].join('/');
  assert.ok(!keys.has(key), 'Duplicate result'); keys.add(key);
  const c = byId.get(row.caseId);
  assert.ok(c);
  const quality = row.completionStatus === 'incomplete' || !row.response.trim()
    ? { status: 'rejected', validator: c.responseContract.kind, reasons: ['incomplete_response'] }
    : prepareResponseValidator(c.responseContract)(row.response);
  assert.deepEqual(row.quality, quality);
  const fence = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(row.response.trim());
  if (fence) formattingDiagnostics.push({ caseId: row.caseId, version: row.version,
    repetition: row.repetition, primaryStatus: quality.status,
    contentMatchesAfterRemovingSingleFence: prepareResponseValidator(c.responseContract)(fence[1]).status === 'verified' });
  if (row.cost?.status === 'measured') measured += row.cost.amountUsd;
}
assert.ok(Math.abs(measured - (report.accounting.measuredCostUsd ?? 0)) < 1e-10);
assert.ok(report.accounting.accountedCostUsd + 1e-10 >= measured);
assert.ok(report.accounting.accountedCostUsd <= report.budget.maxCostUsd + 1e-10);
assert.ok(report.budget.maxCostUsd <= report.budget.userAuthorizedCostUsd);
assert.deepEqual(load('summary.json'), JSON.parse(JSON.stringify(summarize(report))));

// Money/quality regressions: unknown cost never becomes zero; zero successes has no cost per success.
const sample = { ...report, status: 'completed', plan: [{ caseId: 'test', group: 'test', repetition: 1 }],
  results: ['normal', 'compact'].map(version => ({ caseId: 'test', group: 'test', repetition: 1, version,
    quality: { status: 'rejected' }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, cost: null })) };
const group = summarize(sample).groups[0];
assert.equal(group.versions.normal.measuredCostUsd, null);
assert.equal(group.versions.compact.observedCostPerCorrectReturnedAnswerUsd, null);
assert.equal(group.successfulTaskSavingsPercent, null);
assert.equal(group.qualityPreservedInReturnedPairs, false);
sample.results.pop();
assert.equal(summarize(sample).groups[0].measuredCostReductionPercent, null);
console.log(JSON.stringify({ verified: true, results: report.results.length, requests: report.accounting.requests,
  measuredCostUsd: measured, accountedCostUsd: report.accounting.accountedCostUsd, formattingDiagnostics }));
