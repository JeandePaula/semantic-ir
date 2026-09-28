# Local and response contracts

Use a supported contract only when it represents the user's requested operation. Unknown fields/rules are rejected, not guessed. These commands do not make LLM calls.

## JSON selection

An exact path:

```json
{"kind":"json_select_v1","data":{"launch":{"color":"GREEN"}},"path":["launch","color"]}
```

An exact equality filter followed by projection:

```json
{"kind":"json_select_v1","data":{"rows":[{"id":"900719925474099312","code":"GREEN"}]},"path":["rows"],"where":{"path":["id"],"equals":"900719925474099312"},"select":["code"]}
```

Paths contain object keys or nonnegative array indices. An empty path selects the current value. Filters default to exactly one match; zero or multiple matches are errors. Set `cardinality: "many"` to return all matches in source order. `select` then projects each match. Missing paths fail. No regex, shell, expressions, or inherited-property access. Preserve large IDs as strings.

## Order allocation v1

`{"kind":"order_allocation_v1","data":INPUT}` accepts:

- `products`: `{sku, price_cents, cost_cents, enabled, name?}`.
- `stocks`: `{warehouse, sku, on_hand, reserved}` for every catalog SKU at each warehouse, including zero/disabled stock.
- `routes`: destination keys mapped to ordered arrays of `{warehouse, shipping_cents}`.
- `minimum_contribution_cents`: nonnegative integer.
- `orders`: `{id, revision, event_seq, status, priority, created_at, destination, discount_bps, external_ref, items, customer_note?}`. Status is `active` or `cancelled`; timestamps are ISO UTC with seconds and optionally 1–3 fractional digits; items contain `{sku, qty, quoted_price_cents?}`. References are strings.

Rules are fixed and versioned:

1. Keep the largest `(revision, event_seq)` for each ID; reject duplicate version tuples as ambiguous. Exclude the latest cancelled events.
2. Process priority descending, time ascending, then ID by ordinal string order ascending.
3. Start with `on_hand - reserved`. Each order needs a single warehouse. Reject unknown/disabled items and nonpositive quantities before stock/margin checks; combine repeated SKUs.
4. Use catalog prices only. Compute the whole-order discount as `floor(gross * discount_bps / 10000)` with integer arithmetic. Ignore customer notes and quoted prices.
5. Choose the first route warehouse with complete stock and `net - goods_cost - shipping >= minimum_contribution`. Deduct stock only after approval. Otherwise return `insufficient_stock` or `insufficient_margin` according to whether any warehouse had full stock.
6. Return complete `approved`, `rejected`, sorted `cancelled`, `superseded_events`, approved-only `totals`, and `remaining` stock. Empty orders are allowed; empty item lists are rejected as unspecified input.

All monetary/quantity fields must be safe integers; discounts are 0–10000 basis points. Intermediate arithmetic uses BigInt. Unrepresentable JSON integer results, invalid references, duplicate products/stocks/routes, unknown fields, and over-reserved stock are errors. The solver does not interpret arbitrary natural-language instructions. If rules differ, this contract does not apply.

## JSON query v1

`{"kind":"json_query_v1","data":DATA,"path":["records"],"steps":[...]}` starts from an array. Steps run in declared order:

- `{"op":"filter","all":[{"op":"eq","path":["active"],"value":true},{"op":"gte","path":["priority"],"value":2}]}`: conjunction of predicates. `eq` compares primitive values without coercion; `gt`, `gte`, `lt`, `lte` require safe integers. Every predicate path is checked, even if another is false.
- `{"op":"sort","by":[{"path":["priority"],"direction":"desc","type":"integer"},{"path":["id"],"direction":"asc","type":"string"}]}`: stable multi-key ordering. Specify direction and type on every key. String comparison uses ordinal UTF-16 order; ties preserve input order.
- `{"op":"project","path":["label"]}`: one value per row, preserving order.
- `{"op":"sum","path":["cents"]}`: exact safe-integer sum via BigInt; overflow is rejected. Empty input returns zero.
- `{"op":"count"}`: row count, including zero. `sum` and `count` must be last.

An empty path addresses the current row/value. Missing fields, wrong key types, unknown operators/fields and steps after a scalar are rejected. Programs allow at most 32 steps, 32 predicates per filter and 16 sort keys. No expressions, implicit coercion, regex, network or dynamic code. Empty arrays have no row fields to validate.

Use CLI `plan --file QUERY.json` or MCP `plan_local_query` to inspect operator input/output types and program/data hashes. Planning checks schema, source array and operator order; actual row paths/types are checked during `execute`. A plan does not prove equivalence to prose or certify the result. Execute using the same CLI `execute` / MCP `execute_local` path as other tasks. Return the exact result without model rewriting.

## Response verification

```json
{"kind":"exact_text","expected":"GREEN"}
```

```json
{"kind":"exact_json","expected":"{\"total\":42,\"ids\":[\"A\",\"B\"]}"}
```

`exact_text` requires the entire string, including whitespace. `exact_json` ignores layout/object key order but requires all values, types, keys, and array order. Markdown fences, trailing text, duplicate keys, unsafe integers, and numbers whose decimal spelling would lose precision are rejected. Use strings for exact high-precision decimals. The reference must come from a trusted independent source. Passing a contract says nothing about whether the reference itself was correct.

Use MCP `verify_response` or `semantic-ir verify --contract CONTRACT.json --file ANSWER.json` for a saved response. CLI exit status is nonzero on failure. For inference, use MCP `invoke_prompt.responseContract`, CLI `invoke --contract`, or SDK `RuntimeRouter.invoke(..., {responseContract})`. Contract validation occurs before spending; a response mismatch is rejected after recording its cost. No automatic paid retry is made.

If accepting a surrounding Markdown fence is part of the application's contract, explicitly set `"normalization":"single_json_fence"` on `exact_json` before inference. Only a complete `json` fence is removed; the same strict parser and full-value comparison follow. Extra prose, multiple documents and incorrect values still fail. Do not use this option to silently relax a user's raw-JSON requirement or relabel a historical benchmark. Runtime `outputText` is the verified presentation; `response.text` retains provider evidence.

## Native OpenRouter output shape

MCP `invoke_prompt.outputShape` / CLI `--output-shape SHAPE.json` / SDK `OpenAIAdapter(..., {outputShape})` optionally request a strict JSON shape during generation. The shape is independent of the local `responseContract` oracle. Examples: `{"type":"string"}`, `{"type":"array","items":{"type":"string"}}`, `{"type":"object","properties":{"total":{"type":"integer"}}}`. Primitive types also include `number`, `boolean` and `null`. Object fields are all required, with no extra keys. Shapes allow up to 256 nodes and 16 levels; arbitrary schema keywords, examples, constants and answer enums are rejected.

The provider receives a schema for `{"value":ANSWER}` and an instruction explaining the envelope. OpenRouter routing requires parameter support and preserves the configured price ceiling. Only a complete valid envelope is decoded; extra keys, a copied source object, duplicate keys or lossy numbers fail. Raw provider text remains in the SDK; CLI/MCP return validated JSON for the requested answer. The reference itself is never sent. Use `exact_json` for reference checks; contradictory shape/reference pairs fail before spending. A valid shape without an oracle still has `quality: unverified`. Unsupported endpoints fail without retrying in plain mode.

Schema/instruction/wrapper overhead counts toward reservations and reported usage. A shape-specific fingerprint prevents reuse of ordinary-text profiles. Custom CLI/SDK calibration needs compatible `exact_json` oracles; built-in MCP calibration remains ordinary text. Native schemas are currently OpenRouter-only, opt-in, and have not yet been paid-validated here. A compiled runtime quality failure invalidates that profile until reverification, with no automatic second paid call.
