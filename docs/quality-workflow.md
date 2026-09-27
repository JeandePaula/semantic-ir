# Quality before compression

## Decision

Use a skill to choose the workflow, with tested code enforcing explicit contracts. Keep the existing compiler, paid evaluation, and gateway for callers that need them. Do not replace the engine with prompt instructions alone: instructions cannot enforce arithmetic, reject a truncated answer, or account for a billed failure.

The default order is: **explicit local operation → verified result → LLM only for work requiring interpretation**. Local operations are opt-in structured tasks, not a classifier that guesses the meaning of arbitrary prose. The initial contracts are `json_select_v1` and `order_allocation_v1`. New business rules need a new tested operation/version, not a silent change to an existing contract.

## Techniques considered

| Technique | Evidence and fit | Decision |
| --- | --- | --- |
| Program-aided computation | [PAL](https://arxiv.org/abs/2211.10435) separates language interpretation from computation. This project's failed benchmark is dominated by exact rules and arithmetic. | Apply the execution principle with reviewed, fixed operations. Unlike PAL, this implementation does not generate or execute arbitrary model-produced programs. |
| Avoid unnecessary LLM requests | [OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization) includes local/classical computation and fewer requests among its recommendations. | Use local selection/calculation when the contract is known; retain exact results in file artifacts to reduce repeated tool-output context. |
| Learned prompt compression | [LLMLingua-2](https://www.microsoft.com/en-us/research/project/llmlingua/llmlingua-2/) trains token classification for prompt compression. | Not adopted here: deleting tokens needs workload-specific quality evidence and does not fix the observed arithmetic errors in the uncompressed baseline. This is a fit decision, not a claim the technique never works. |
| JSON schema / structured output | [OpenRouter structured output](https://openrouter.ai/docs/api_reference/overview#structured-outputs) controls response shape. | Useful for syntax, insufficient for the wrong discount, ordering and inventory values observed here. Validate the complete answer against a trusted oracle instead. |
| Evaluation before promotion | [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices) recommends task-specific evaluation, edge cases, and trustworthy references. | Preserve held-out data and old failed results. Add offline reference comparison, generated cases, malformed input tests, and runtime rejection. |

## Boundaries and behavior

- Local execution returns the complete result, a versioned contract ID, hashes, and zero downstream calls/tokens/cost. This is a code execution result, not an LLM equivalence score. The SDK has no provider adapter on this path.
- CLI `execute --out` writes the exact result to a new file and returns only a receipt. MCP `execute_local` returns the result inline and may add host context tokens. Neither route controls the host agent's primary inference.
- Input validation rejects unspecified fields, ambiguous event versions, duplicate catalog/stock/route entries, missing references, invalid numeric ranges, and incomplete stock matrices. Business-level invalid items return the contract's rejection reason. BigInt arithmetic avoids discount/product overflow; unsafe output integers are refused.
- `exact_text` and `exact_json` response contracts are prepared before provider invocation. JSON equality checks values/types/array order and all keys, ignoring only object key order/layout. Duplicate keys, unsafe integers and decimals that round when parsed are refused. Large IDs and high-precision decimals belong in strings.
- Known incomplete or empty provider answers are rejected even without an oracle. The adapter retains available usage/cost, the runtime records it, and no automatic paid retry occurs. The [OpenRouter finish reason contract](https://openrouter.ai/docs/api_reference/overview#finish-reason) distinguishes a normal stop from truncation/filter/tool/error outcomes.
- Without a trusted oracle the runtime labels quality `unverified`. A stable compression profile and fallback to the original prompt are not correctness guarantees. The basic gateway exposes this status but does not accept task-specific contracts; use SDK/CLI/MCP for those checks. Unsupported gateway passthrough remains outside this gate.
- Exact references are appropriate for closed regression tests or independent computed answers. Do not spend a model call to reproduce a known result unless testing the model is itself the task. Open-ended work still needs task-specific tests or reviewed rubrics.

## Reproduction and economics

Run `npm run check`, `npm run build`, and `npm run verify:local`. To intentionally refresh only the new local artifacts, use `npm run verify:local -- --write`. The verifier never updates the pre-existing expected answer or paid results. It compares the full allocation result to that reference, permutes event arrival order, executes all six extraction inputs, and rejects all four historical model responses.

The [local report](reports/local-execution.json) records 6/6 exact extraction results and an exact complex answer with zero downstream inference tokens. Its 19 rotations/reversals are metamorphic tests, not 19 new workload families. Unit tests additionally exercise 100 random event permutations and 250 generated stock/price/quantity/discount cases against an independent closed-form oracle, as well as margin/order/precision boundaries and malformed inputs.

The historical normal complex calls consumed 20,494 total tokens and $0.00623324 across two returned responses; compressed calls consumed 14,739 and $0.00471438. All four failed full correctness. The local path eliminates these downstream calls for the formalized operation and produces the reference result. This is not an equal-quality comparison between two LLM prompts or a measured production ROI. Development, host inference, local machine expense, and previous calibration spend remain outside the local execution cost.
