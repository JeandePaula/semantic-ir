# Semantic IR

Local prompt analysis, conservative compression, and cost-aware LLM experiments. Semantic IR aims to reduce **cost per successful task**, measured against the original prompt. It keeps the original request when a codec lacks a stable profile or the runtime's risk checks reject the transformation.

[Português](README.pt-BR.md) · [Architecture](docs/architecture.md) · [Host integrations](docs/integrations.md) · [Detailed findings](docs/improvements.md)

## Measured results

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
```

These checks are local and do not make paid calls. The complex experiment includes its full prompt, reference solver, evaluator, raw responses, and budget accounting. Its paid runner requires `--allow-spend` and refuses to overwrite existing results.

The repository covers conservative analysis, literal detection, declarative codecs, OpenAI/OpenRouter adapters, SQLite profiles, MCP, CLI, and a local gateway. Open-ended quality evaluators, robust evidence for coding/reasoning, transparent host-primary optimization, and multi-user production deployment remain out of scope.

See [testing and release](docs/testing-and-release.md), [data model](docs/data-model.md), and [host integration decision](docs/decisions/0002-host-integrations.md). License: [MIT](LICENSE).
