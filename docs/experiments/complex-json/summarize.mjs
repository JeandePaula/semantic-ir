import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const dir=fileURLToPath(new URL('./',import.meta.url));
const report=JSON.parse(readFileSync(dir+'results.json','utf8'));
const expected=JSON.parse(readFileSync(dir+'expected.json','utf8'));
if(!report.finishedAt && !report.error) throw new Error('Wait for the paid run to finish');
const dispositions=answer=>Object.fromEntries([
  ...(answer.approved??[]).map(x=>[x.id,'approved']),
  ...(answer.rejected??[]).map(x=>[x.id,x.reason]),
  ...(answer.cancelled??[]).map(id=>[id,'cancelled']),
]);
const runs=report.results.map(run=>{
  let answer=null;
  try{answer=JSON.parse(run.response);}catch{/* scored below */}
  const metrics={validJson:run.evaluation.validJson,allCorrect:run.evaluation.passed,
    dispositionsCorrect:answer!==null && isDeepStrictEqual(dispositions(answer),dispositions(expected)),
    approvedSequenceCorrect:isDeepStrictEqual(answer?.approved?.map(x=>x.id),expected.approved.map(x=>x.id)),
    rejectedSequenceCorrect:isDeepStrictEqual(answer?.rejected?.map(x=>x.id),expected.rejected.map(x=>x.id)),
    approvedRowsCorrect:expected.approved.filter(row=>isDeepStrictEqual(answer?.approved?.find(x=>x.id===row.id),row)).length,
    supersededAndCancelledCorrect:answer?.superseded_events===expected.superseded_events && isDeepStrictEqual(answer?.cancelled,expected.cancelled),
    totalsCorrect:isDeepStrictEqual(answer?.totals,expected.totals),
    remainingCorrect:isDeepStrictEqual(answer?.remaining,expected.remaining),
    untrustedNoteIgnored:answer?.rejected?.some(x=>x.id==='O-005' && x.reason==='invalid_item')??false,
    catalogPriceUsed:answer?.approved?.find(x=>x.id==='O-002')?.gross_cents===10500};
  if(answer===null) {
    for(const key of Object.keys(metrics)) {
      if(key!=='validJson' && key!=='allCorrect') metrics[key]=null;
    }
  }
  const name=run.version+'-'+run.repetition+'.json';
  if(answer!==null) writeFileSync(dir+name,JSON.stringify(answer,null,2)+'\n');
  else writeFileSync(dir+run.version+'-'+run.repetition+'.txt',run.response);
  return {version:run.version,repetition:run.repetition,metrics,costUsd:run.cost?.amountUsd??null,usage:run.usage};
});
const comparison=Object.fromEntries(['normal','compact'].map(version=>{
  const entries=runs.filter(x=>x.version===version);
  return [version,{completedResponses:entries.length,exactMatches:entries.filter(x=>x.metrics.allCorrect).length,
    validJson:entries.filter(x=>x.metrics.validJson).length,
    costUsd:entries.reduce((sum,x)=>sum+(x.costUsd??0),0),
    inputTokens:entries.reduce((sum,x)=>sum+(x.usage.inputTokens??0),0),
    outputTokens:entries.reduce((sum,x)=>sum+(x.usage.outputTokens??0),0),
    cachedInputTokens:entries.reduce((sum,x)=>sum+(x.usage.cachedInputTokens??0),0)}];
}));
const balanced=comparison.normal.completedResponses===comparison.compact.completedResponses;
const summary={model:report.model,method:report.method.replace('Three repetitions per version','Planned three repetitions per version'),reference:'expected.json',
  exactMatchRule:'All keys, values, types and array order must match; JSON object key order and whitespace are ignored.',
  error:report.error??null,prompts:report.prompts,runtimeDecision:report.runtimeDecision,runs,
  comparison,savingsPercentForCompletedPairs:balanced && comparison.normal.costUsd>0
    ?100*(1-comparison.compact.costUsd/comparison.normal.costUsd):null,
  accounting:report.accounting,allPlannedCallsCompleted:report.results.length===report.plannedCalls,
  failedCallsWithUnknownBilling:report.accounting.requests-report.results.length,
  qualityGatePassed:report.results.length>0 && report.results.every(run=>run.evaluation.passed)};
writeFileSync(dir+'summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
