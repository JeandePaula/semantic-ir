import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const round = value => Number(value.toFixed(10));
const sumAvailable = (entries, getter) => entries.length && entries.every(r => typeof getter(r) === 'number' && Number.isFinite(getter(r)))
  ? round(entries.reduce((sum, r) => sum + getter(r), 0)) : null;
const reduction = (before, after) => before !== null && before > 0 && after !== null ? 100 * (1 - after / before) : null;

export function summarize(report) {
  const groups = [...new Set(report.plan.map(r => r.group))].map(group => {
    const rows = report.results.filter(r => r.group === group);
    const plannedPairs = report.plan.filter(r => r.group === group);
    const versions = Object.fromEntries(['normal', 'compact'].map(version => {
      const entries = rows.filter(r => r.version === version);
      const correct = entries.filter(r => r.quality.status === 'verified').length;
      const costUsd = sumAvailable(entries, r => r.cost?.status === 'measured' ? r.cost.amountUsd : null);
      return [version, { returnedCalls: entries.length, fullyCorrect: correct,
        incomplete: entries.filter(r => r.completionStatus === 'incomplete').length,
        inputTokens: sumAvailable(entries, r => r.usage.inputTokens),
        cachedInputTokens: sumAvailable(entries, r => r.usage.cachedInputTokens),
        outputTokens: sumAvailable(entries, r => r.usage.outputTokens),
        reasoningTokens: sumAvailable(entries, r => r.usage.reasoningTokens),
        totalTokens: sumAvailable(entries, r => r.usage.totalTokens),
        measuredCostUsd: costUsd,
        observedCostPerCorrectReturnedAnswerUsd: correct > 0 && costUsd !== null ? round(costUsd / correct) : null,
      }];
    }));
    const pairs = plannedPairs.map(plan => {
      const normal = rows.find(r => r.caseId === plan.caseId && r.repetition === plan.repetition && r.version === 'normal');
      const compact = rows.find(r => r.caseId === plan.caseId && r.repetition === plan.repetition && r.version === 'compact');
      const bothReturned = Boolean(normal && compact);
      const bothCorrect = bothReturned && normal.quality.status === 'verified' && compact.quality.status === 'verified';
      const costKnown = bothReturned && [normal, compact].every(r => r.cost?.status === 'measured' && typeof r.cost.amountUsd === 'number');
      const savings = costKnown ? reduction(normal.cost.amountUsd, compact.cost.amountUsd) : null;
      return { caseId: plan.caseId, repetition: plan.repetition, bothReturned, bothCorrect,
        normalQuality: normal?.quality ?? null, compactQuality: compact?.quality ?? null,
        costReductionPercent: savings,
        verifiedLowerCost: bothCorrect && savings !== null && savings >= 1,
        bothUncached: bothReturned && normal.usage.cachedInputTokens === 0 && compact.usage.cachedInputTokens === 0 };
    });
    const paired = pairs.filter(p => p.bothReturned);
    const balanced = rows.length > 0 && rows.length === paired.length * 2;
    const allReturnedCorrect = balanced && paired.every(p => p.bothCorrect);
    return { group, versions, pairs, completedPairs: paired.length, plannedPairs: plannedPairs.length,
      qualityPreservedInReturnedPairs: allReturnedCorrect,
      allPlannedPairsCompleted: paired.length === plannedPairs.length,
      allReturnedPairsPassQualityAndSavings: balanced && paired.every(p => p.verifiedLowerCost),
      inputTokenReductionPercent: balanced ? reduction(versions.normal.inputTokens, versions.compact.inputTokens) : null,
      totalTokenReductionPercent: balanced ? reduction(versions.normal.totalTokens, versions.compact.totalTokens) : null,
      measuredCostReductionPercent: balanced ? reduction(versions.normal.measuredCostUsd, versions.compact.measuredCostUsd) : null,
      successfulTaskSavingsPercent: allReturnedCorrect
        ? reduction(versions.normal.measuredCostUsd, versions.compact.measuredCostUsd) : null,
    };
  });
  return { provider: report.provider, model: report.model, startedAt: report.startedAt, finishedAt: report.finishedAt ?? null,
    status: report.status, stopReason: report.stopReason ?? null, settings: report.settings, budget: report.budget,
    accounting: report.accounting, groups, promoted: false,
    limitations: ['Small paired sample; not statistical equivalence or a production guarantee.',
      'Reasoning/output/cache variation is included in measured total cost; bytes are not tokens.',
      'Per-version costs cover returned calls only; failed/unknown-billing reservations remain in overall accounting.',
      'Complex prompts use direct experimental calls; the production risk gate remains unchanged.'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(readFileSync(new URL('results.json', import.meta.url), 'utf8'));
  const summary = summarize(report);
  writeFileSync(new URL('summary.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
