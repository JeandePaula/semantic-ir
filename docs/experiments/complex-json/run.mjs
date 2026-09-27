import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { openStore, adapterFor, providerFor } from '../../../apps/cli/dist/service.js';
import { BudgetLedger, RuntimeRouter } from '@semantic-ir/engine';
import { evaluate } from './evaluate.mjs';

if (!process.argv.includes('--allow-spend')) throw new Error('Paid experiment requires --allow-spend');
const dir=fileURLToPath(new URL('./',import.meta.url));
const output=dir+'results.json';
if (existsSync(output)) throw new Error('Results already exist; do not repeat spending or overwrite evidence');
const earlier=JSON.parse(readFileSync(new URL('../../reports/openrouter-json-runtime.json',import.meta.url),'utf8'));
const prompts={normal:readFileSync(dir+'prompt.txt','utf8').trimEnd(),compact:readFileSync(dir+'prompt.compact.txt','utf8').trimEnd()};
const expected=JSON.parse(readFileSync(dir+'expected.json','utf8'));
const ledger=new BudgetLedger({maxRequests:24-earlier.experimentTotalRequests,maxTokens:100000-8546,
  maxCostUsd:0.02-earlier.experimentTotalAccountedCostUsd,maxDurationMs:600000});
const store=openStore();
const results=[];
const summary={startedAt:new Date().toISOString(),provider:providerFor(store),model:store.getSetting('defaultModel'),
  maxOutputTokens:6144,reasoning:'configured_default',plannedCalls:6,results,
  prompts:Object.fromEntries(Object.entries(prompts).map(([key,text])=>[key,{bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}]))};

function persist() {
  summary.accounting={requests:ledger.usedRequests,tokens:ledger.usedTokens,measuredCostUsd:ledger.measuredCostUsd,
    accountedCostUsd:ledger.usedCostUsd,cumulativeRequests:earlier.experimentTotalRequests+ledger.usedRequests,
    cumulativeMeasuredCostUsd:earlier.experimentTotalMeasuredCostUsd+(ledger.measuredCostUsd??0),
    cumulativeAccountedCostUsd:earlier.experimentTotalAccountedCostUsd+ledger.usedCostUsd};
  writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
}

try {
  if(summary.provider!==earlier.provider || summary.model!==earlier.model) throw new Error('Provider/model changed');
  const adapter=adapterFor(store,summary.model);
  const fp=await adapter.getModelFingerprint();
  if(fp.fingerprintSha256!==earlier.decision.fingerprintSha256) throw new Error('Model settings changed');
  summary.runtimeDecision=(await new RuntimeRouter(adapter,store).decide(prompts.normal)).decision;
  summary.method='Controlled direct comparison; does not promote a profile or override runtime risk gates. Three repetitions per version, alternating pair order. Response cache disabled; provider input cache reported.';
  persist();
  for(let repetition=1;repetition<=3;repetition++) {
    for(const version of repetition===2?['compact','normal']:['normal','compact']) {
      const response=await ledger.invoke(adapter,{model:summary.model,prompt:prompts[version],mode:'safe',
        maxOutputTokens:summary.maxOutputTokens,disableResponseCache:true});
      const evaluation=evaluate(response.text,expected);
      results.push({repetition,version,response:response.text,usage:response.usage,cost:response.cost,
        latencyMs:response.latencyMs,evaluation});
      persist();
      console.log(JSON.stringify({repetition,version,passed:evaluation.passed,differences:evaluation.differences.length,
        usage:response.usage,cost:response.cost?.amountUsd}));
    }
  }
  summary.comparison=Object.fromEntries(['normal','compact'].map(version=>{
    const entries=results.filter(x=>x.version===version);
    return [version,{runs:entries.length,exactMatches:entries.filter(x=>x.evaluation.passed).length,
      validJson:entries.filter(x=>x.evaluation.validJson).length,costUsd:entries.reduce((s,x)=>s+(x.cost?.amountUsd??0),0),
      inputTokens:entries.reduce((s,x)=>s+x.usage.inputTokens,0),outputTokens:entries.reduce((s,x)=>s+x.usage.outputTokens,0),
      cachedInputTokens:entries.reduce((s,x)=>s+(x.usage.cachedInputTokens??0),0),
      latencyMs:entries.reduce((s,x)=>s+x.latencyMs,0)}];
  }));
  const {normal,compact}=summary.comparison;
  summary.savingsPercent=normal.costUsd>0?100*(1-compact.costUsd/normal.costUsd):null;
  summary.sameParsedAnswersAcrossAllRuns=results.every(x=>x.evaluation.validJson) &&
    results.every(x=>isDeepStrictEqual(JSON.parse(x.response),JSON.parse(results[0].response)));
  summary.finishedAt=new Date().toISOString();
  persist();
  console.log(JSON.stringify({comparison:summary.comparison,savingsPercent:summary.savingsPercent,accounting:summary.accounting}));
} catch(error) {
  summary.error=error instanceof Error?error.message:String(error);
  persist();
  throw error;
} finally {store.close();}
