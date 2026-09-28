# Paid response retest — September 28, 2026

Protocol frozen before inference. OpenRouter model `z-ai/glm-5.3-flash`, default reasoning and temperature, response cache disabled. Reuses four extraction inputs and the complete allocation regression input, with their pre-existing expected answers. Compare original and losslessly compacted prompts with identical settings and alternating version order.

The primary content contract is complete `exact_json` equality with explicitly declared `single_json_fence` normalization. Raw JSON compliance is reported separately as `strictQuality`; neither values nor calculations are repaired. Raw provider responses are retained. A complete answer is required in both checks. No profile is promoted, and no natural-language quality guarantee is implied.

Plan: five pairs, at most 16 provider attempts including rate-limit retries, 150,000 accounted tokens, $0.05 accounted cost and 15 minutes. The existing user-authorized ceiling is $0.20. The fresh catalog rate is $0.15/M input and $0.50/M output, and the conservative initial full-plan reservation is about $0.0399. The originally proposed $0.02 operational cap was increased before inference because the catalog rate changed. Actual returned bills and unresolved failure reservations will be reported separately. Stop after a pair with failed content quality or unavailable billing; stop on a budget/transport error. Do not automatically restart a failed run.

The paired benchmark deliberately calls the model even where local execution is available, because this experiment tests model responses. Normalization does not alter the model prompt or make incorrect arithmetic correct. This is a repeated regression sample, not unseen holdout data or a controlled attribution of model changes across dates/providers.

Reproduction: `node run.mjs` only performs preflight; `node run.mjs --allow-spend` makes paid calls and refuses to overwrite existing results. Running another experiment needs a new explicit budget/run directory. The original September 27 evidence remains unchanged.

## Observed result

The experiment stopped after the first pair under the declared quality rule. **Two calls, 3,352 reported tokens, $0.000522050 measured total cost**, no rate-limit retries and no unresolved billing (apart from a negligible floating-point residual in the accounting field). Both answers completed and reported zero cached input tokens.

| Version | Actual response | Input / output tokens | Measured cost | Content / raw JSON contract |
| --- | --- | ---: | ---: | --- |
| Original | `"CORAL"` | 2,133 / 45 | $0.000342450 | Pass / pass |
| Compact | `{"launch":{"color":"CORAL"}}` | 1,164 / 10 | $0.000179600 | Fail / fail: object instead of requested string |

The compact version reduced this pair's measured cost by **47.55%**, but this is **not successful-task savings**. The fact `CORAL` was retained; the requested output type was not. Single-fence normalization cannot repair a changed JSON structure, so the validator correctly rejected the answer. No answer rewriting or additional paid retry was used to conceal the failure.

The other three extraction pairs and the complex pair were **not run**. This small early-stop result does not measure their quality and does not establish a general failure rate or prove compaction caused the difference. The price change also prevents direct dollar comparisons with the previous day's run without accounting for rates. Runtime inspection remained read-only, and no profile was promoted.

Evidence: [raw responses and accounting](results.json), [summary](summary.json), [frozen prompts and contracts](cases.json), [preflight](preflight.json). From the repository root, run `node docs/experiments/openrouter-compression-2026-09-28/verify.mjs` for offline integrity, quality, compaction and accounting checks; this makes no paid calls.
