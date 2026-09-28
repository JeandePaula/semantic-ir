# Semantic compilation and the paid response failure

This review uses the September 27 captured OpenRouter responses, not a new paid trial. Reproduce the [machine-readable analysis](reports/paid-response-analysis.json) with `npm run analyze:paid`. The original responses, expectations, strict failure labels, and billing reservations remain unchanged.

## Why fewer tokens cost more

The complex pair used `z-ai/glm-5.3-flash` at the experiment's recorded rates: $0.045 per million input tokens and $0.14 per million output tokens. Both requests reported zero cached input. These are historical prices, not a current price quote.

| Component | Original | Compact | Dollar change (compact minus original) |
| --- | ---: | ---: | ---: |
| Input tokens | 4,248 | 2,886 | −$0.000061290 |
| Output tokens, including reasoning | 6,444 | 7,259 | +$0.000114100 |
| Total tokens | 10,692 | 10,145 | Different rates prevent comparison by count alone |
| Measured total cost | $0.001093320 | $0.001146130 | **+$0.000052810 / +4.83%** |

Output costs about 3.11 times as much per token. Saving 1,362 input tokens pays for only 437.79 extra output tokens; the actual increase was 815. Of those extra output tokens, 380 were reported as reasoning and 435 were other output. Reasoning is a subset of output, so it must not be charged twice. The price decomposition matches the reported bill to floating-point precision. Rate-limit reservations are separate from this returned-pair comparison and remain in overall experiment accounting.

One pair cannot explain *why* output length changed. Default sampling, representation sensitivity, and different reasoning paths are hypotheses, not demonstrated causes. Internal reasoning text was not captured. Lowering the output cap merely to force a smaller bill would risk truncation; earlier experiments already showed that failure. Reasoning changes need fresh quality evidence before deployment.

## What was wrong with the answers

Both complex answers are complete JSON but fail the independent reference: 68 differing paths in the original, 70 in the compact response. Both match cancellation and superseded-event counts; approved orders, rejections, totals, and remaining stock differ.

Both begin their approved list with `O-007, O-015, O-012, O-014`, whereas the reference begins `O-002, O-010, O-001, O-003`. The latest revisions' priorities in the actual approved sequence are nondecreasing, opposite to the contract's descending priority. This is visible in the returned ordering; it does not expose the model's internal processing. Inventory consumption depends on that order, so ordering is a correctness requirement, not presentation. The existing local allocation contract executes the exact rules and matches the complete frozen reference.

The extraction object case had a different defect: every value was right, but both answers wrapped the JSON in Markdown. An explicitly selected `single_json_fence` normalization now removes only a whole surrounding JSON fence before strict comparison. It does not change values, discard extra fields, accept trailing commentary, or repair calculations. Raw JSON remains the default. Offline replay under the new opt-in policy verifies 8/8 extraction answers and rejects both complex answers. This post-hoc result is **not** a new model evaluation, an alteration of historical 3/4 scores, or permission to promote a profile.

## Relevant research and what fits

There are compilers and programming systems for LLM workflows, but the cited systems do not establish a universal, lossless natural-language-to-short-prompt compiler.

| Primary source | What it compiles or optimizes | Decision for this project |
| --- | --- | --- |
| [DSPy — Compiling Declarative Language Model Calls into Self-Improving Pipelines](https://arxiv.org/abs/2310.03714) | Declarative LM modules composed into pipelines, optimized against a metric using demonstrations/prompts. | Keep correctness and end-to-end cost as acceptance metrics. Do not add optimization calls when exact computation already solves the task. DSPy integration could fit a future open-ended workload with sufficient evaluation data and budget. |
| [LMQL — Prompting Is Programming](https://arxiv.org/abs/2212.06094) | Language-model programs with control flow and output constraints, compiled into inference procedures. | Adopt explicit contracts and a typed local plan. Our post-response validator is not LMQL constrained decoding, and neither syntax constraints nor schema validity prove arithmetic correctness. |
| [LLMCompiler — An LLM Compiler for Parallel Function Calling](https://arxiv.org/abs/2312.04511) | A planner, task-fetching unit, and executor for dependency-aware tool calls. | Separate planning from execution. A sequential JSON query needs no LLM planner or parallel orchestration framework. Revisit for actual multi-tool workloads. |
| [PAL — Program-aided Language Models](https://arxiv.org/abs/2211.10435) | Language interpretation paired with external program execution for computation. | Keep exact arithmetic in reviewed local code. Unlike PAL, this engine accepts only declared operators and never evaluates generated JavaScript/Python. |

These are design lessons inferred from the papers, not reproductions of their systems or benchmark savings. Adding a framework alone would not make this OpenRouter workload cheaper or correct.

## Implemented changes

- `json_query_v1` extends local execution with conjunctive filters, stable multi-key sorting with explicit direction/type, projection, exact integer sum, and count. `plan --file` / MCP `plan_local_query` compile a declared program into typed operator metadata with program/data hashes. Field existence/types are checked during execution; planning alone does not certify the data result. There is no arbitrary code execution or automatic prose translation.
- The four recent extraction inputs and the full allocation input now replay locally against their pre-existing independent expected outputs, all matching with zero downstream calls. This removes downstream inference for these supported tasks; it excludes host tokens, development and machine costs.
- Calibration checks the original answer before paying for a candidate. A failed original produces an explicit skipped candidate with null metrics, not a fabricated zero-cost success. Custom suites accept strict `exact_json` oracles, validated across all scored splits before spending; unknown oracle kinds cannot score. JSON object key order/layout differences no longer reject a correct structured answer.
- Optional single-fence normalization is explicit, local, and followed by full answer validation. SDK `response.text` preserves raw provider evidence; `outputText` is the validated presentation used by CLI/MCP. No repair calls or hidden retries were added.
- Task classification ignores literal payloads, so an instruction-like field in JSON cannot by itself change extraction into coding. The analyzer remains heuristic and conservative.
- Runtime inspection is read-only: `decide()` reports fingerprint drift without mutating profile status. Actual invocation records drift. Existing drifted profiles remain unpromoted.
- Reusable cost attribution separates input/cache/output costs, measured deltas, unexplained differences, and the output-token break-even threshold. Missing usage remains unknown. Reasoning is never added twice.

## Validation and remaining limits

`npm run check` covers types, lint and 139 tests, including generated ordering/arithmetic inputs, local CLI/MCP integration, skipped-call accounting, malformed oracles, raw-evidence preservation and historical regressions. `npm run build` exports the updated schemas and integrations. `npm run analyze:paid` checks the reproducible analysis; `npm run verify:local` checks the prior independent allocation reference and extraction fixtures. The historical experiment's own `verify.mjs` still checks the unchanged paid evidence.

The effective workflow is: formalize known rules once, run local operators, return the exact artifact, and use LLM inference only where interpretation is needed. Open-ended responses still need a trustworthy task-specific evaluator. This revision makes no new paid quality/savings claim and does not restore the drifted compression profile. The next paid experiment, if requested, should predeclare its normalization policy and compare repeated pairs with a frozen independent oracle, total cost and correctness gates.
