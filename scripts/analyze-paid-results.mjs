import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@semantic-ir/core';
import { compareResponseCosts, executeLocalTask, prepareResponseProcessor } from '@semantic-ir/engine';
import { evaluate } from '../docs/experiments/complex-json/evaluate.mjs';

// Offline replay only. Never imports a provider or edits paid responses/expectations.
const dir = new URL('../docs/experiments/openrouter-compression-2026-09-27/', import.meta.url);
const source = readFileSync(new URL('results.json', dir), 'utf8');
const paid = JSON.parse(source);
const casesText = readFileSync(new URL('cases.json', dir), 'utf8');
assert.equal(sha256(casesText), paid.casesSha256);
const { cases } = JSON.parse(casesText);
const expected = JSON.parse(readFileSync(new URL('../docs/experiments/complex-json/expected.json', import.meta.url)));
const input = JSON.parse(readFileSync(new URL('../docs/experiments/complex-json/input.json', import.meta.url)));
const pairs = paid.plan.flatMap(plan => {
  const rows = paid.results.filter(row => row.caseId === plan.caseId && row.repetition === plan.repetition);
  const normal = rows.find(row => row.version === 'normal');
  const compact = rows.find(row => row.version === 'compact');
  if (!normal || !compact) return [];
  return [{ caseId: plan.caseId, repetition: plan.repetition, ...compareResponseCosts(normal, compact, paid.price) }];
});
const normalizedReplay = paid.results.map(row => {
  const c = cases.find(c => c.id === row.caseId);
  const processed = prepareResponseProcessor({ ...c.responseContract, normalization: 'single_json_fence' })(row.response);
  assert.notEqual(row.completionStatus, 'incomplete');
  return { caseId: row.caseId, version: row.version, historicalStatus: row.quality.status,
    optInReplayStatus: processed.quality.status, normalization: processed.normalization };
});
assert.equal(normalizedReplay.filter(row => row.caseId !== 'complex-allocation' && row.optInReplayStatus === 'verified').length, 8);
assert.equal(normalizedReplay.filter(row => row.caseId === 'complex-allocation' && row.optInReplayStatus === 'verified').length, 0);

// Explicit mappings reviewed against the saved prompts, not an automatic prose compiler.
const descriptors = {
  'nested-color': { kind: 'json_select_v1', path: ['launch', 'color'] },
  'large-string-id': { kind: 'json_select_v1', path: ['records'],
    where: { path: ['id'], equals: '900719925474099312' }, select: ['code'] },
  'filtered-labels': { kind: 'json_query_v1', path: ['records'], steps: [
    { op: 'filter', all: [{ op: 'eq', path: ['active'], value: true }, { op: 'eq', path: ['region'], value: 'west' }] },
    { op: 'project', path: ['label'] },
  ] },
  'structured-record': { kind: 'json_select_v1', path: ['launch'] },
};
const localReplay = cases.map(c => {
  const data = c.id === 'complex-allocation' ? input : JSON.parse(/```json\n([\s\S]*?)\n```/.exec(c.normal)[1]);
  const descriptor = c.id === 'complex-allocation' ? { kind: 'order_allocation_v1' } : descriptors[c.id];
  const result = executeLocalTask({ ...descriptor, data });
  assert.deepEqual(result.result, JSON.parse(c.responseContract.expected));
  return { caseId: c.id, exactMatch: true, resultSha256: result.verification.resultSha256,
    providerCalls: result.usage.providerCalls, downstreamTokens: result.usage.totalTokens, downstreamCostUsd: result.costUsd };
});
const complexErrors = paid.results.filter(row => row.group === 'complex').map(row => {
  const evaluation = evaluate(row.response, expected);
  const actual = JSON.parse(row.response);
  const priorities = actual.approved.map(order => input.orders.filter(item => item.id === order.id)
    .sort((a, b) => b.revision - a.revision || b.event_seq - a.event_seq)[0].priority);
  return { version: row.version, differenceCount: evaluation.differences.length, sections: evaluation.sections,
    expectedApprovedIds: expected.approved.map(order => order.id),
    actualApprovedIds: actual.approved.map(order => order.id), actualApprovedPriorities: priorities,
    prioritiesNondecreasing: priorities.every((priority, i) => i === 0 || priorities[i - 1] <= priority),
    firstDifferences: evaluation.differences.slice(0, 6) };
});
assert.equal(complexErrors.length, 2);
const complexPair = pairs.find(pair => pair.caseId === 'complex-allocation');
assert.ok(Math.abs(complexPair.measuredDeltaUsd - 0.00005281) < 1e-12);
assert.ok(Math.abs(complexPair.unexplainedDeltaUsd) < 1e-12);
const report = { method: 'Offline price attribution, opt-in presentation replay and explicit local execution; no new inference',
  sourceFile: 'docs/experiments/openrouter-compression-2026-09-27/results.json',
  sourceSha256: sha256(source), casesSha256: sha256(casesText), price: paid.price,
  newProviderCalls: 0, newDownstreamCostUsd: 0, pairs, complexErrors, normalizedReplay, localReplay,
  limitations: [
    'One complex pair cannot establish why output length changed; no internal reasoning text was captured.',
    'Approved-order sequence is observed; internal processing steps are not observable.',
    'Normalization replay uses a new opt-in contract and does not change historical strict failures or promote a profile.',
    'Local mappings were explicitly reviewed against fixed rules; arbitrary prose equivalence is not established.',
    'Zero local downstream cost excludes host inference, development, machine costs and historical spend.',
  ] };
const target = new URL('../docs/reports/paid-response-analysis.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
else assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), JSON.parse(JSON.stringify(report)));
console.log(JSON.stringify({ verified: true, newProviderCalls: 0, localCasesPassed: localReplay.length,
  complexCostAttribution: complexPair, normalizedExtractionAnswers: '8/8 (post-hoc, opt-in)' }, null, 2));
