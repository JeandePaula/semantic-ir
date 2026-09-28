# Semantic IR

Deterministic local data operations, answer verification, and conservative prompt compression. Semantic IR reduces **cost per successful task** by choosing local execution when the rules are explicit, then using measured LLM optimization where interpretation is needed. A routing fallback to the original prompt does not guarantee a correct answer.

[Português](README.pt-BR.md) · [Architecture](docs/architecture.md) · [Host integrations](docs/integrations.md) · [Detailed findings](docs/improvements.md)

## Start with a verified local operation

The complex allocation experiment exposed the wrong optimization target: both normal and compacted prompts produced incorrect calculations. The current workflow moves exact selection, arithmetic, sorting, and inventory updates into tested code. A short [skill](integrations/codex/skills/semantic-ir/SKILL.md) guides the choice of route and verification; CLI/MCP enforce the supported contracts.

| Current local check | Correctness | Downstream LLM tokens | Downstream API cost |
| --- | --- | ---: | ---: |
| Six JSON extraction inputs | 6/6 exact answers | 0 | $0 |
| Complete complex allocation input | Exact match to the pre-existing independent reference, all fields | 0 | $0 |

The complex result also survives 19 deterministic event-order permutations. The automated suite adds 100 randomized event permutations, 250 generated quantity/price/stock/discount cases, malformed-data checks, numeric precision tests, and response rejection tests. These cover explicit contracts, not arbitrary reasoning.

This avoids **100% of downstream inference tokens for these supported operations**. Host-agent reasoning/tool-output tokens, development effort, CPU, and electricity are not included. This is a change of execution architecture, not evidence that general prompt compression preserves quality. No new paid calls were needed. See the [reproducible local report](docs/reports/local-execution.json), [complete correct result](docs/experiments/complex-json/local-result.json), and [design/research comparison](docs/quality-workflow.md).

After building, solve the allocation example directly:

```sh
node apps/cli/bundle/main.js execute --kind order_allocation_v1 \
  --file docs/experiments/complex-json/input.json --out allocation-answer.json
npm run verify:local
```

`--out` writes the full answer to a **new** file and prints only a compact receipt, avoiding a large tool result in the host context. Without `--out`, the result is printed. Local execution needs no model, credentials, profile, or calibration. For a JSON selection, save a task file:

```json
{"kind":"json_select_v1","data":{"launch":{"color":"GREEN"}},"path":["launch","color"]}
```

Run `semantic-ir execute --file task.json` or MCP `execute_local` with `{ "task": ... }`. Read the [versioned contracts](integrations/codex/skills/semantic-ir/references/contracts.md) for filtering and allocation rules. Unknown or ambiguous rules must be handled explicitly; the engine does not translate arbitrary prose into these contracts.

## Reject incorrect model answers

CLI `invoke --contract contract.json`, MCP `invoke_prompt.responseContract`, and SDK `RuntimeRouter.invoke(..., {responseContract})` support trusted exact-text and exact-JSON references:

```json
{"kind":"exact_json","expected":"{\"total\":42}"}
```

Contracts are checked before spending. The final answer must match all fields, values, types, and array order; JSON object key order and layout may differ. Duplicate keys, unsafe numbers, and precision-losing decimals are rejected. `exact_text` includes whitespace. A mismatch or known incomplete response is rejected after recording its usage/cost, without a hidden paid retry. CLI exits nonzero and MCP sets `isError`; the rejected answer is not returned as a successful deliverable. Offline verification uses `semantic-ir verify --contract contract.json --file answer.json` or `verify_response`.

Without a reference, responses are explicitly **unverified**. A reference must itself be trustworthy; copying a model answer into it proves nothing. For open-ended work, use task-specific tests or human-reviewed evaluation. A skill or a valid JSON schema cannot guarantee factual correctness.

If the application accepts a single JSON Markdown fence, declare `"normalization":"single_json_fence"` in the `exact_json` contract before inference. The complete contents must still match. Default validation remains strict raw JSON. SDK `outputText` contains the validated presentation and `response.text` retains the raw provider answer; CLI/MCP report normalization metadata.

To request the output shape **during generation**, OpenRouter calls now accept an explicit `outputShape`, such as `{"type":"string"}`. CLI: add `--output-shape docs/examples/string-output-shape.json`; MCP: pass `invoke_prompt.outputShape`; SDK: pass it to `OpenAIAdapter`. The adapter requests strict structured output, validates its declared `value` envelope locally, then verifies the decoded answer against the independent reference. Shape validity alone is not answer correctness. The schema contains no expected answer, its overhead is budgeted, and its protocol participates in calibration fingerprints. See [native output contracts](docs/native-output-contracts.md) for usage and limits.

A compiled runtime answer that fails quality validation now marks its profile `needs_reverification`, records the bill, and returns an error without a paid retry. The next request uses the original pending recalibration. This correction passed 155 offline tests, including the captured failure and CLI/MCP propagation; the new native protocol has **not** been paid-tested and makes no new savings claim.

## Compression results

### Paid response retest — September 28, 2026

The new OpenRouter / `z-ai/glm-5.3-flash` comparison stopped after its first pair under the predefined quality rule. Original: **`"CORAL"`**, correct, **$0.000342450**. Compact: **`{"launch":{"color":"CORAL"}}`**, incorrect output type, **$0.000179600**. Both completed with zero cached input. The compact call cost **47.55% less**, but failed both the content contract (including predeclared optional fence normalization) and strict raw-JSON reference comparison. This is not verified savings for a successful task.

Total: **two calls, 3,352 tokens, $0.000522050 measured**. The other four planned pairs, including the complex case, were skipped to avoid spending after a quality failure. No profile was promoted. Catalog prices had changed to $0.15/M input and $0.50/M output; comparisons use identical settings and rates within the pair. See the [full report and raw evidence](docs/experiments/openrouter-compression-2026-09-28/README.md). Local execution remains the verified route for these explicit operations; the new code does not guarantee model adherence to the prompt.

### Cost diagnosis and local improvements — September 28, 2026

The recent complex pair saved **$0.000061290 in input** but added **$0.000114100 in output**, including reasoning: the net increase was **$0.000052810 (+4.83%)**. At the recorded prices, 437.79 extra output tokens would exhaust the input savings; the response added 815. One pair cannot establish why generation length changed. Both answers also returned the approved orders in the wrong priority direction and failed the full reference.

The new `json_query_v1` compiler runs explicit filter/sort/project/sum/count programs locally. The four recent extraction inputs plus the allocation input now match their frozen expected answers locally, **5/5 with zero downstream calls/tokens/cost**. Optional single-fence normalization verifies 8/8 saved extraction answers in an offline replay; historical strict scores remain 3/4 on each side, and both complex model answers still fail. No new paid calls or profile promotion were performed.

Calibration now skips the candidate if the original fails, supports strict JSON-value oracles, and validates expectations before spending. Routing inspection no longer mutates profiles. See the [response analysis and research decisions](docs/semantic-compilation.md), [reproducible report](docs/reports/paid-response-analysis.json), and [query example](docs/examples/query.json). Research includes DSPy, LMQL, LLMCompiler and PAL; the implementation adopts explicit execution contracts without adding an LLM planner.

```sh
node apps/cli/bundle/main.js plan --file docs/examples/query.json
node apps/cli/bundle/main.js execute --file docs/examples/query.json
npm run analyze:paid
```

The example returns `["B","A"]`. Planning checks schema/operator order; execution checks actual field paths/types. Host inference and machine costs are outside the zero-downstream measurement. These local checks do not demonstrate a general improvement in model quality.

### Paid retest — September 27, 2026

A new OpenRouter / `z-ai/glm-5.3-flash` run tested four fresh extraction inputs and one returned pair of the complex allocation task. All ten returned responses reported **zero cached input tokens**. Normal and compressed requests used the same settings within each pair.

| Workload | Original input tokens | Compressed input tokens | Original cost | Compressed cost | Cost change | Strict correctness |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Four extraction pairs | 9,035 | 5,056 | $0.000534395 | $0.000356180 | **33.35% lower** | **3/4 on each side**; the fourth used Markdown fences |
| Complex allocation, one pair | 4,248 | 2,886 | $0.001093320 | $0.001146130 | **4.83% higher** | **0/1 on each side**; ordering/allocation/totals errors |

The first three extraction pairs were fully correct on both sides, with individual cost reductions of **38.89%, 43.04%, and 24.16%**. The fourth preserved the object contents, including Unicode and escaped text, but both answers violated the raw-JSON output contract. Removing a single Markdown fence verified the contents as a supplementary diagnostic; it did **not** change the primary failure result.

For the complex task, output grew from **6,444 to 7,259 tokens**, outweighing the input savings in dollar cost. Neither answer was truncated at the new 12,288-token cap, yet both failed the independent reference. The planned second repetition was skipped under the predefined stop rule. **Neither complete workload passed the combined correctness and savings gate; no profile was promoted.**

The run made **13 provider attempts**, including three rate-limit retries, and received ten answers. Provider-reported charges total **$0.003130025**. An additional **$0.002495460** remains conservatively reserved for attempts without reported billing, for **$0.005625485 accounted**, below the user's $0.20 authorization and the run's lower $0.05 cap. These per-version costs cover returned answers; reserves are included only in the overall accounting. The current catalog price differs from the earlier run, and the old profile was marked `needs_reverification` on fingerprint drift.

See the [full retest report](docs/experiments/openrouter-compression-2026-09-27/README.md), [computed metrics](docs/experiments/openrouter-compression-2026-09-27/summary.json), and [raw responses/accounting](docs/experiments/openrouter-compression-2026-09-27/results.json). This small sample supports the three successful extraction pairs, not a general quality or production-savings guarantee.

### Earlier paid experiments

These are small experiments with **OpenRouter / `z-ai/glm-5.3-flash`**, run on September 26, 2026. They are not a claim of universal savings or statistical equivalence.

| Experiment | Original | Compressed | Observed reduction | Quality result |
| --- | ---: | ---: | ---: | --- |
| Local JSON payload comparison, six cases | 18,636 bytes | 7,185 bytes | **61.45% fewer bytes** | Structural preservation; no model calls |
| Simple JSON extraction, two held-out pairs | $0.00010912 | $0.00007260 | **33.47% lower measured cost** | Both versions correct in both pairs |
| New simple extraction input, one additional pair | $0.00006408 | $0.00004492 | **29.90% lower measured cost** | Both correct; zero cached input on both sides |
| Complex allocation task, two returned responses per version | $0.00623324 | $0.00471438 | **24.37% lower measured cost** | **0/2 fully correct on each side — failed quality gate** |

The simple extraction experiment passed all six calibration, validation, and holdout pairs. It promoted `json_compact` for that model's extraction profile. A new input then confirmed `decision.mode: compiled` and the correct response. The held-out candidates each used 256 cached input tokens while their baselines used none, so the 33.47% result includes that advantage. The additional pair had no cached input on either side.

The simple experiment used 14 calls and cost **$0.000618** in total. Its calibration alone cost $0.000509, with a projected break-even of 28 comparable requests. Recovering all 14 calls would require about 34 requests at the observed holdout savings. These are projections, not realized net production savings.

### The complex test did not establish preserved quality

The complex prompt contains 19 order events, three warehouses, revision selection, priority ordering, inventory reservations, discounts, contribution thresholds, cancellation rules, large string identifiers, and an instruction-like customer note that must be ignored. A deterministic reference answer was computed before any model calls.

- Input decreased from **4,248 to 2,886 provider-reported tokens per call** (32.06%).
- The first original response used a discount of 3,263 cents instead of 326 and selected an incorrect warehouse. The second original response reached the 6,144-token output limit and returned incomplete JSON.
- Both compressed responses returned valid JSON but made ordering, allocation, total, or inventory errors. Valid JSON did not mean a correct answer.
- Three repetitions per version were planned. The fifth attempt, an original request, returned no usable text and stopped the run. Only the two returned responses per version are used in the comparison above; one original response was truncated.
- The runtime independently classified this prompt as high risk and selected the original. The direct experiment did not promote a broader profile or bypass that gate in production.

**Lower cost on failed tasks is not successful optimization.** This result limits the supported claim to the tested simple extraction workload. General reasoning, arithmetic, and constraint-heavy tasks remain unverified.

The complex test recorded **$0.01094762** in measured charges for four returned responses. Billing for the failed fifth call is unavailable; its **$0.00442536 estimated reservation** was retained, giving $0.01537298 accounted for this test. Across both experiments, 19 requests were attempted, $0.01156562 was measured, and $0.01599098 was accounted including the unresolved reservation, within the authorized local $0.02 envelope. This local estimate is not a provider-side billing guarantee.

### Evidence

- [Offline byte comparison](docs/reports/local-compression.json)
- [Simple extraction calibration and holdout](docs/reports/openrouter-json-calibration.json)
- [New input: compiled runtime and uncached comparison](docs/reports/openrouter-json-runtime.json)
- [Complex experiment report](docs/experiments/complex-json/README.md), [original prompt](docs/experiments/complex-json/prompt.txt), [compressed prompt](docs/experiments/complex-json/prompt.compact.txt), [reference answer](docs/experiments/complex-json/expected.json), and [raw results](docs/experiments/complex-json/results.json)

## What changed

- **Audit before spending.** Local screening rejects larger prompts, reductions below 128 bytes, and candidates that produce identical text. It reports bytes without presenting them as token or dollar savings.
- **Lexical JSON compression.** `json_compact` removes JSON whitespace outside strings while preserving number spellings, escapes, duplicate keys, and key order. It validates JSON grammar but does not parse and reserialize the data. Formatting-sensitive requests are left unchanged.
- **Verifiable transformations.** A compacted JSON literal is accepted only when replaying the complete deterministic transformation reproduces the submitted text. This preserves data, not a guarantee of identical model behavior.
- **Cost-aware selection.** Candidates must preserve task success and reduce total cost by at least 1% in every scored case across calibration, validation, and holdout. A failed candidate stops early. Network latency no longer vetoes an otherwise correct, cheaper candidate.
- **Reconciled budgets.** Successful responses replace conservative reservations with reported usage and cost. Failed calls with unknown billing retain their reservations.
- **Honest diagnostics.** Reports include input, output, reasoning, cached input, candidate rejection reasons, and projected calibration break-even.
- **Controlled inference policy.** OpenRouter reasoning settings participate in the model fingerprint. Response caching is disabled for calibration, rather than for every priced runtime call. Provider failures do not silently trigger a second paid inference.

## Quick start: no API spending

Use Node.js 24 or newer, npm, and Bash on Linux, macOS, or WSL. `node:sqlite` emits an experimental warning on Node 24.

```sh
git clone https://github.com/JeandePaula/semantic-ir.git
cd semantic-ir
npm ci
npm run build
node apps/cli/bundle/main.js init
node apps/cli/bundle/main.js doctor
node apps/cli/bundle/main.js audit --suite json-extraction
node apps/cli/bundle/main.js audit --file path/to/prompt.txt
npm run audit:savings
```

The build exports JSON schemas, bundles the CLI, and produces integration packages in `apps/cli/assets/integrations/`. Local analysis and auditing do not need credentials. The MCP equivalent of `audit` is `audit_prompt`.

## Configure a provider

OpenRouter and OpenAI are supported. Import your own API key using the hidden terminal prompt:

```sh
node apps/cli/bundle/main.js credentials import --provider openrouter
node apps/cli/bundle/main.js configure --provider openrouter --model z-ai/glm-5.3-flash
node apps/cli/bundle/main.js doctor
```

You can also use `OPENROUTER_API_KEY` or `OPENAI_API_KEY`. Imported credentials are kept outside the repository under `~/.config/semantic-ir/` with mode `0600`. `doctor` reports whether a key is configured without printing it.

For OpenAI, select `--provider openai`, choose a model available to your account, and supply current account prices with `--input-price`, `--cached-price`, `--output-price`, and `--price-version`. Prices are expressed in USD per million tokens.

## Paid calibration

The following command makes paid calls and can promote a profile:

```sh
node apps/cli/bundle/main.js calibrate \
  --model z-ai/glm-5.3-flash --task extraction --suite json-extraction \
  --allow-spend --max-requests 24 --max-tokens 100000 \
  --max-cost-usd 0.02 --max-duration-ms 240000 --max-output-tokens 256
node apps/cli/bundle/main.js calibration report
node apps/cli/bundle/main.js profile
```

Each execution has its own budget and incurs new charges. `benchmark` evaluates without promoting. `json-extraction` is the default suite; `redundant-extraction`, `synthetic-exact`, and custom suite JSON files are also accepted. Custom suites need scored cases with distinct IDs and prompts across calibration, validation, and holdout.

OpenRouter uses a conservative byte-based preflight envelope, a price ceiling, and provider-reported usage/cost reconciliation. The local USD limit is estimated; use a provider-side key spending limit for an external cap. OpenAI uses provider token counting and your configured prices. Missing evidence stays unavailable.

| Report field | Meaning |
| --- | --- |
| `promoted` | Whether this execution activated a profile |
| `holdoutEvidence` | Cost and success evidence only for the held-out sample |
| `screenedCandidates` | Candidates skipped before inference |
| `diagnostics` | Output growth, insufficient savings, and related observations |
| `economics.breakEvenRequests` | Projected requests needed to recover the calibration cost |
| `reservations` | Cumulative preflight ceilings, not actual spending |
| `run.usedCostUsd` | Reconciled costs plus unresolved reservations |

For compatible OpenRouter models, reasoning can be configured explicitly:

```sh
node apps/cli/bundle/main.js configure --provider openrouter --model YOUR_MODEL --reasoning none
```

Values are `default`, `none`, `minimal`, `low`, `medium`, and `high`; model support varies. The default preserves provider behavior. The same setting applies to the original, candidate, and runtime, and changing it requires recalibration. Hiding reasoning does not avoid its cost; see the [OpenRouter reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## CLI, MCP, and host plugins

```sh
npm pack --workspace apps/cli
npm install -g ./semantic-ir-cli-0.3.1.tgz
semantic-ir integrations build --out ./dist
semantic-ir install codex
semantic-ir install claude
semantic-ir install antigravity
```

The `install` commands print the host-specific steps; follow those instructions. See the [integration guide](docs/integrations.md) for Codex, Claude Code, Antigravity, WSL, and ChatGPT. The CLI must be available in the environment that launches the MCP server. A Windows host can use the WSL bridge generated by `integrations build --wsl-distro Ubuntu-24.04`.

MCP provides local analysis, audit, compilation, validation, profiles, metrics, routing explanations, and explicitly authorized downstream model calls. Profiles and reports live in `~/.semantic-ir/semantic-ir.sqlite`, overridable with `SEMANTIC_IR_DB`.

**Installing a plugin does not intercept or reduce the host agent's primary inference.** Optimization applies to application requests or downstream calls explicitly routed through Semantic IR. The `host_primary_prompt` scope remains unavailable.

## Local gateway

```sh
semantic-ir proxy --port 8787
curl http://127.0.0.1:8787/health
```

The gateway binds to localhost and supports a restricted, single-user-text form of `POST /v1/chat/completions`. Unsupported chat features are forwarded without compilation. `/metrics` and `/dashboard` distinguish observed costs and holdout evidence from unverified production savings. Set `SEMANTIC_IR_GATEWAY_KEY` to require a bearer token. This is a local, single-user service.

## Verification and scope

```sh
npm run check
npm run build
npm run audit:savings
node docs/experiments/complex-json/prepare.mjs
node docs/experiments/complex-json/summarize.mjs
npm run verify:local
node docs/experiments/openrouter-compression-2026-09-27/verify.mjs
```

These checks are local and do not make paid calls. The complex experiment includes its full prompt, reference solver, evaluator, raw responses, and budget accounting. Its paid runner requires `--allow-spend` and refuses to overwrite existing results.

The repository covers conservative analysis, literal detection, declarative codecs, OpenAI/OpenRouter adapters, SQLite profiles, MCP, CLI, and a local gateway. Open-ended quality evaluators, robust evidence for coding/reasoning, transparent host-primary optimization, and multi-user production deployment remain out of scope.

See [testing and release](docs/testing-and-release.md), [data model](docs/data-model.md), and [host integration decision](docs/decisions/0002-host-integrations.md). License: [MIT](LICENSE).
