# Complex prompt: original vs. compacted

**Subsequent local solution:** the versioned `order_allocation_v1` executor now produces the complete independent reference answer with zero downstream inference calls. See [local-result.json](local-result.json), the [offline report](../../reports/local-execution.json), and [workflow decision](../../quality-workflow.md). This changes execution architecture; it does not turn the failed compression experiment below into a success. The original prompt, reference, and paid responses remain unchanged.

**Result: quality preservation was not established.** The compacted requests were cheaper in the two returned pairs, but neither version produced a completely correct answer. This is a failed quality experiment, not evidence of lower cost per successful task.

## Task and reference answer

The Portuguese prompt asks the model to process 19 events representing 15 distinct orders across three warehouses. It must:

1. Select the latest revision and resolve event-sequence ties.
2. Exclude cancelled orders and process active orders by descending priority, timestamp, and ID.
3. Merge repeated SKU quantities and subtract reserved inventory.
4. Reject unknown/disabled products and nonpositive quantities.
5. Apply an order-level basis-point discount with integer floor.
6. Select the first eligible warehouse using route preference, complete inventory, and a minimum contribution.
7. Preserve large external references as strings, ignore an instruction-like customer note, and report allocations, rejection reasons, totals, and remaining inventory.

The reference was computed locally **before** provider calls and cross-checked for allocation order, the nontrivial discount, and event counts. It has 8 approved orders, 6 rejected orders, 1 cancelled order, and 4 superseded events. Expected gross revenue is 112,800 cents, discounts 2,411 cents, net revenue 110,389 cents, shipping 3,500 cents, and contribution 46,889 cents. These are fictitious data.

- [Full original prompt](prompt.txt)
- [Compacted prompt](prompt.compact.txt)
- [Input data](input.json)
- [Expected answer](expected.json)
- [Reference generator](prepare.mjs) and [strict evaluator](evaluate.mjs)

The `json_compact` transformation only removes JSON whitespace outside strings. All instructions and data values remain. Deterministic preservation checks passed. Exact answer evaluation ignores JSON object key order and whitespace, but requires every field, value, type, and array order to match the reference.

## Protocol and results

The experiment ran on September 26, 2026 using OpenRouter `z-ai/glm-5.3-flash`, unchanged reasoning settings, and a 6,144-token output limit for both variants. Response caching was disabled; provider input caching was recorded separately. Three repetitions per version were planned with alternating order: original/compact, compact/original, original/compact.

Four responses were returned. The fifth attempt, an original request, failed with `openrouter response did not contain text`; the sixth call was not made. One of the four returned responses was truncated. There were no hidden retries to replace failed answers, prompt edits after observing results, or profile promotions.

| Metric | Original | Compacted |
| --- | ---: | ---: |
| Prompt bytes | 16,789 | 9,416 |
| Provider input tokens per call | 4,248 | 2,886 |
| Returned responses | 2 | 2 |
| Valid JSON | 1/2 | 2/2 |
| Fully correct answers | **0/2** | **0/2** |
| Measured cost of returned responses | $0.00623324 | $0.00471438 |
| Output tokens across returned responses | 11,998 | 8,967 |
| Cached input tokens across returned responses | 4,224 | 0 |

Compression reduced bytes by 43.92% and reported input tokens by 32.06%. The cost difference for the two returned pairs was 24.37%. That comparison includes output variation and cache behavior, and one baseline answer was truncated. With no fully correct result on either side, it does not demonstrate successful-task savings or statistical equivalence.

### Concrete quality failures

- [Original run 1](normal-1.json): `O-010.discount_cents` was **3263**, expected **326**. `O-011` was assigned to warehouse **C**, expected **S**. The totals and inventory were wrong; 6 of 8 approved rows matched the reference in full.
- [Original run 2](normal-2.txt): consumed the complete 6,144-token output allowance and ended in the middle of the rejected-order array, producing invalid JSON.
- [Compacted run 1](compact-1.json): started approvals with low-priority `O-007` instead of `O-002`; incorrectly approved `O-007` and rejected `O-010`. Totals and inventory were wrong; 4 of 8 reference approved rows matched in full when aligned by ID.
- [Compacted run 2](compact-2.json): also failed disposition, ordering, totals, and inventory checks; 5 of 8 reference approved rows matched in full when aligned by ID.

All three parseable answers rejected the customer-note injection target and used the catalog price for the repeated-SKU order. Those isolated successes do not compensate for the allocation and arithmetic failures. For truncated JSON, business-level checks are unavailable rather than evidence that the model obeyed or disobeyed each rule.

## Budget accounting

The test used the remaining budget after the earlier simple extraction experiment. It attempted 5 calls, with $0.01094762 measured for the four returned responses. The fifth call's billing was unavailable to the adapter, so its estimated $0.00442536 reservation was retained. The accounted amount for this experiment is therefore $0.01537298; it is not an exact invoice total.

Together with the earlier 14 calls, the session attempted 19 of the authorized 24 requests. Measured charges total $0.01156562, while the accounted amount including the unresolved reserve is $0.01599098, below the authorized local $0.02 envelope. Token accounting likewise retains the failed request's reservation. No further paid calls were made after the failure.

## Runtime decision and implication

The prompt produced 18 detected constraints. The existing runtime returned `mode: original` and `high_risk_or_low_classification_confidence` before any call. This direct, user-requested experiment evaluated both variants without changing that protection or expanding the simple extraction profile.

The observed failures show why data-preserving compression still needs behavioral evaluation. The small extraction experiment's success must not be generalized to this allocation workflow. A future implementation should perform ordering, arithmetic, and stock transitions in deterministic application code and evaluate model extraction separately; that redesign was not part of this comparison.

## Evidence and local reproduction

[Raw responses, usage, costs, and evaluations](results.json) · [Derived summary](summary.json)

```sh
npm run build
node docs/experiments/complex-json/prepare.mjs
node docs/experiments/complex-json/summarize.mjs
```

These commands do not call a provider. `run.mjs` is the paid runner used for the recorded experiment. It requires explicit `--allow-spend` and refuses to overwrite the included results, preventing accidental repetition of charges. Repeating a paid experiment requires a new evidence location, an explicit new budget, and appropriate credentials; deleting a result file does not grant spending authorization.
