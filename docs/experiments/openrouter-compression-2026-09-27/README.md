# OpenRouter compression retest — September 27, 2026

This is a new paid comparison using `z-ai/glm-5.3-flash`, the same model as the earlier experiment. The user authorized up to **$0.20** and requested minimal spending. The run uses a lower **$0.05 operational cap**, at most 16 provider attempts (including retries), 200,000 accounted tokens, and 15 minutes. The preflight ceiling for the planned 12 successful calls was $0.01750385; retries can add reservations.

## Results

**Completed: five pairs / ten returned answers. Stopped after the first complex pair failed the quality gate.** The second complex repetition was deliberately skipped. No profile was promoted.

| Case | Original cost | Compressed cost | Cost reduction | Original correct | Compressed correct |
| --- | ---: | ---: | ---: | --- | --- |
| Nested color | $0.000110685 | $0.000067640 | 38.89% | Yes | Yes |
| Large string ID | $0.000143335 | $0.000081650 | 43.04% | Yes | Yes |
| Filtered labels | $0.000150605 | $0.000114215 | 24.16% | Yes | Yes |
| Structured record | $0.000129770 | $0.000092675 | 28.59% | No: Markdown fences | No: Markdown fences |
| Complex allocation | $0.001093320 | $0.001146130 | **−4.83% (more expensive)** | No: wrong answer | No: wrong answer |

All ten returned calls reported **zero cached input tokens**. Extraction input decreased from 9,035 to 5,056 tokens (44.04%), total tokens from 9,948 to 5,975 (39.94%), and cost from $0.000534395 to $0.000356180 (33.35%). Strict success was 3/4 in each version. Total returned cost divided by correct answers was $0.0001781317 versus $0.0001187267; these empirical ratios include the returned formatting failures, but exclude the unallocated unknown-billing reserves and are not production estimates.

The structured-record answers contain the correct data. A supplementary offline check removes only the surrounding single JSON fence and compares all values again; both then match. The primary contract requires raw JSON, so both remain failures in every headline metric. This distinction separates format noncompliance from lost information without changing the acceptance rule after observing results.

The complex answers used 4,248 versus 2,886 input tokens (32.06% fewer), but **6,444 versus 7,259 output tokens**. Total tokens fell from 10,692 to 10,145 (5.12%) while dollars increased 4.83%. Both answers started approvals with `O-007` instead of `O-002`, violating priority order and changing subsequent allocations, totals and remaining stock. Both preserved cancellation/superseded-event counts. Neither was truncated. Cost per correct complex answer is **unavailable**, because neither succeeded.

**Spending:** 13 provider attempts, ten returned answers, three rate-limit retries. The returned answers used 36,760 provider-reported total tokens and cost **$0.003130025**. The ledger retains **$0.002495460** for attempts without reported billing, totaling **$0.005625485 accounted** and 88,972 accounted tokens including reservations. Reserved amounts are not measured charges. No additional paid calls were made after the stop condition.

**Conclusion:** three new extraction pairs met both correctness and lower-cost requirements. Neither whole workload passed all gates. The complex run shows why fewer input or even total tokens do not necessarily lower cost or ensure a correct answer. The validated local executor remains the supported route for this explicit allocation contract.

## Protocol

- Four new extraction inputs: nested scalar, lookup by a large string ID, filtered labels, and a structured record with Unicode/escaped text. Each is tested once per version with a 512-token output cap.
- Up to two pairs of the existing complex allocation task, using its unchanged prompt and independent reference, with a 12,288-token output cap on both versions. The earlier run capped output at 6,144, so it is not an identical-configuration replication.
- Original/compacted order alternates across extraction pairs and across planned complex repetitions. The codec removes only JSON whitespace outside strings; prompts and references are saved in `cases.json` before spending.
- Default reasoning and temperature are preserved. Response caching is disabled on both sides; any provider input-cache usage is still reported.
- Exact JSON comparison ignores only object key order and whitespace. Values, types, keys, and array order must match. Markdown fences, truncation, and incorrect calculations fail the primary gate.
- Stop after the first complex pair with either answer incorrect, or a pair with missing billing evidence. Transport/budget failure stops the run. No automatic profile promotion or extra trial to improve a bad result.

Current catalog ceilings were **$0.045/M input tokens** and **$0.14/M output tokens**, different from the historical experiment. Actual provider charges, rather than those ceilings, determine the reported cost. The fresh price fingerprint caused runtime inspection to mark the prior extraction profile `needs_reverification`. The complex task also remains high risk. Direct experimental calls do not bypass these gates in production.

## Evidence and reproduction

- [Frozen cases and references](cases.json)
- [Preflight without inference](preflight.json)
- [Raw responses, charges, attempts, settings and accounting](results.json)
- [Computed results](summary.json)

Offline replay, with no paid requests:

```sh
npm run typecheck
node docs/experiments/openrouter-compression-2026-09-27/summarize.mjs
node docs/experiments/openrouter-compression-2026-09-27/verify.mjs
```

The paid runner requires `--allow-spend` and refuses to run when `results.json` exists. The fixture generator also refuses to change prompts after paid evidence exists. Do not remove these guards or overwrite this experiment to repeat it; a new authorized experiment needs its own preserved evidence and budget.

The sample is small and does not establish statistical equivalence or production savings. Unknown charges stay reserved in overall accounting; they are not treated as zero. Per-version costs describe returned responses only. Cheaper failed answers do not establish successful-task savings. Local deterministic execution remains a separate architecture, with zero downstream inference for its supported contracts.
