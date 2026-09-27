import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openStore, adapterFor, providerFor, providerKey } from '../../../apps/cli/dist/service.js';
import { BudgetLedger, OpenAIAdapter, RuntimeRouter, prepareResponseValidator } from '@semantic-ir/engine';
import { sha256 } from '@semantic-ir/core';
import { summarize } from './summarize.mjs';

const dir = new URL('./', import.meta.url);
const output = new URL('results.json', dir);
const allowSpend = process.argv.includes('--allow-spend');
if (allowSpend && existsSync(output)) throw new Error('Results already exist; refusing duplicate spending');
const casesText = readFileSync(new URL('cases.json', dir), 'utf8');
const { cases } = JSON.parse(casesText);
const store = openStore();
const model = 'z-ai/glm-5.3-flash';
const budget = { userAuthorizedCostUsd: 0.20, maxRequests: 16, maxTokens: 200000,
  maxCostUsd: 0.05, maxDurationMs: 900000 };
const plan = [
  ...cases.filter(c => c.group === 'extraction').map((c, i) => ({ caseId: c.id, group: c.group, repetition: 1,
    order: i % 2 ? ['compact', 'normal'] : ['normal', 'compact'] })),
  { caseId: 'complex-allocation', group: 'complex', repetition: 1, order: ['normal', 'compact'] },
  { caseId: 'complex-allocation', group: 'complex', repetition: 2, order: ['compact', 'normal'] },
];
const ledger = new BudgetLedger(budget);
const report = { provider: 'openrouter', model, startedAt: new Date().toISOString(), status: 'preflight',
  casesSha256: sha256(casesText), budget, plan, results: [], attempts: [],
  settings: { reasoning: 'default', responseCacheDisabled: true, extractionMaxOutputTokens: 512,
    complexMaxOutputTokens: 12288, temperature: 'provider_default', pairedOrder: 'alternating',
    stopRule: 'Stop after first complex pair with either answer incorrect; stop after a pair with unavailable cost; no profile promotion.' } };

function persist() {
  report.accounting = { requests: ledger.usedRequests, returnedResponses: report.results.length,
    accountedTokens: ledger.usedTokens, measuredCostUsd: ledger.measuredCostUsd,
    completeMeasuredCostUsd: ledger.completeMeasuredCostUsd, accountedCostUsd: ledger.usedCostUsd,
    unresolvedReservedCostUsd: Math.max(0, ledger.usedCostUsd - (ledger.measuredCostUsd ?? 0)),
    budgetMethod: ledger.budgetMethod };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(new URL('summary.json', dir), JSON.stringify(summarize(report), null, 2) + '\n');
}

try {
  if (providerFor(store) !== 'openrouter' || store.getSetting('defaultModel') !== model) throw new Error('Configured provider/model differs');
  const reasoning = store.getSetting('reasoning:openrouter:' + model) ?? 'default';
  if (reasoning !== 'default') throw new Error('Reasoning policy changed; comparison protocol requires the previous default');
  const price = await adapterFor(store, model).discoverOpenRouterPrice();
  // Fresh catalog price ceiling; stored provider configuration stays unchanged.
  // Runtime inspection may mark an older profile as needing reverification on price drift.
  const adapter = new OpenAIAdapter(model, { provider: 'openrouter', apiKey: providerKey('openrouter'), price, reasoningEffort: 'default' });
  report.price = price;
  report.fingerprint = await adapter.getModelFingerprint();
  report.runtimeDecisions = Object.fromEntries(await Promise.all(cases.map(async c =>
    [c.id, (await new RuntimeRouter(adapter, store).decide(c.normal)).decision])));
  report.profileStatusAfterInspection = store.getProfile('openrouter', model, 'extraction');
  let plannedUpperCostUsd = 0;
  for (const pair of plan) {
    const c = cases.find(c => c.id === pair.caseId);
    prepareResponseValidator(c.responseContract);
    for (const version of pair.order) {
      const preflight = await adapter.preflight({ model, prompt: c[version], mode: 'safe', maxOutputTokens: c.maxOutputTokens });
      plannedUpperCostUsd += preflight.upperCostUsd;
    }
  }
  report.plannedUpperCostUsd = plannedUpperCostUsd;
  if (plannedUpperCostUsd > budget.maxCostUsd) throw new Error('Full plan exceeds the lower operational budget');
  if (!allowSpend) {
    writeFileSync(new URL('preflight.json', dir), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ paidCalls: 0, model, price, budget, plannedUpperCostUsd, runtimeDecisions: report.runtimeDecisions }));
  } else {
    // Durable spend marker is created exclusively before the first billed request.
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    report.status = 'running';
    persist();
    for (const pair of plan) {
      const c = cases.find(c => c.id === pair.caseId);
      const validate = prepareResponseValidator(c.responseContract);
      for (const version of pair.order) {
        const attempt = { caseId: c.id, group: c.group, repetition: pair.repetition, version, startedAt: new Date().toISOString() };
        report.attempts.push(attempt);
        persist();
        console.log(JSON.stringify({ event: 'request_started', ...attempt, accountedCostUsd: ledger.usedCostUsd }));
        let observed;
        const observedAdapter = {
          getCapabilities: () => adapter.getCapabilities(), getModelFingerprint: () => adapter.getModelFingerprint(),
          preflight: request => adapter.preflight(request), estimateCost: usage => adapter.estimateCost(usage),
          invoke: async request => { observed = await adapter.invoke(request); return observed; },
        };
        let ledgerError;
        try {
          await ledger.invoke(observedAdapter, { model, prompt: c[version], mode: 'safe',
            maxOutputTokens: c.maxOutputTokens, disableResponseCache: true, scope: 'downstream_llm_call' });
        } catch (error) { ledgerError = error; }
        if (observed) {
          const quality = observed.completionStatus === 'incomplete' || !observed.text.trim()
            ? { status: 'rejected', validator: c.responseContract.kind, reasons: ['incomplete_response'] }
            : validate(observed.text);
          report.results.push({ ...attempt, finishedAt: new Date().toISOString(), response: observed.text,
            completionStatus: observed.completionStatus, usage: observed.usage, cost: observed.cost ?? null,
            latencyMs: observed.latencyMs, providerRequestId: observed.providerRequestId, quality });
          attempt.status = 'returned';
          console.log(JSON.stringify({ event: 'request_finished', caseId: c.id, repetition: pair.repetition, version,
            quality, usage: observed.usage, costUsd: observed.cost?.amountUsd ?? null }));
        } else attempt.status = 'failed';
        if (ledgerError) {
          attempt.error = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
          persist();
          throw ledgerError;
        }
        persist();
      }
      const pairRows = report.results.filter(r => r.caseId === c.id && r.repetition === pair.repetition);
      if (pairRows.some(r => r.cost?.status !== 'measured' || typeof r.cost.amountUsd !== 'number')) {
        report.status = 'stopped'; report.stopReason = 'unavailable_billing'; break;
      }
      if (c.group === 'complex' && pairRows.some(r => r.quality.status !== 'verified')) {
        report.status = 'stopped'; report.stopReason = 'complex_quality_gate_failed'; break;
      }
    }
    if (report.status === 'running') report.status = 'completed';
    report.finishedAt = new Date().toISOString();
    persist();
    console.log(JSON.stringify({ event: 'finished', status: report.status, stopReason: report.stopReason ?? null, accounting: report.accounting }));
  }
} catch (error) {
  if (allowSpend && existsSync(output)) {
    report.status = 'failed'; report.stopReason = error instanceof Error ? error.message : String(error);
    report.finishedAt = new Date().toISOString(); persist();
  }
  throw error;
} finally { store.close(); }
