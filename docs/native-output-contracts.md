# Preventing output-shape drift

The [September 28 paid regression](experiments/openrouter-compression-2026-09-28/README.md) asked for a JSON string. The original returned `"CORAL"`; the compressed request returned `{"launch":{"color":"CORAL"}}`. The value was present, but the output type was wrong. This was not truncation, lost source data or a removable Markdown fence. The compressor retained the original output instruction. One returned pair cannot establish the cause of the model's behavior.

The implementation gap was at the generation boundary: `responseContract` validated the answer after inference, but never supplied a machine-readable output shape to the provider. Post-response validation correctly caught the failure. Silently extracting a matching field, changing the expected answer, or counting the cheaper failed result as savings would hide it.

## Optional native output shape

OpenRouter supports `response_format` with a strict JSON schema on compatible endpoints. The adapter now requests that format and `provider.require_parameters: true`, preserving configured price ceilings. Support and enforcement vary by endpoint; the local validator remains necessary. Unsupported requests fail without an unstructured retry. [OpenRouter structured output documentation](https://openrouter.ai/docs/guides/features/structured-outputs), [provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection).

The caller explicitly supplies a small shape declaration, independent of the reference answer:

```json
{"type":"string"}
```

Also supported: `number`, `integer`, `boolean`, `null`, `{"type":"array","items":SHAPE}`, and `{"type":"object","properties":{"field":SHAPE}}`. All object fields are required; extra fields are rejected. Shapes are bounded to 256 nodes and 16 levels. Unknown fields, answer enums, constants, examples, expressions and arbitrary JSON Schema features are not accepted. The [exported input schema](../schemas/json-output-shape-v1.schema.json) describes this language. Precision checks still reject unsafe integers, rounded decimals and duplicate keys in the response.

The wire protocol is `json-envelope/1`: the provider returns exactly `{"value": ANSWER}`. A system instruction explains this wrapper, and the schema defines its single required property. An object envelope allows scalar and array answers on endpoints that require an object root. The engine validates the whole envelope and the declared shape before decoding `value`. For the string declaration, `{"value":"CORAL"}` delivers `"CORAL"`; `{"value":{"launch":{"color":"CORAL"}}}` fails. The historical unwrapped wrong answer still fails. This explicit protocol is not a general repair heuristic.

The expected answer is used only locally, never inserted into the system message or schema. SDK `ModelResponse.text` retains raw provider evidence; `structuredOutput` contains validation metadata and the decoded JSON text only when valid. `modelOutputText(response)` returns that decoded text, or null for a failed native contract. `RuntimeRouter.outputText` is the final presentation used by CLI/MCP. An `exact_json` response reference then checks all values, types, keys and array order. Shape validity alone leaves quality **unverified**.

## Use

For a genuinely needed, authorized OpenRouter call, add `--output-shape docs/examples/string-output-shape.json` to `invoke` alongside `--contract trusted-reference.json`. An exact JSON string reference looks like `{"kind":"exact_json","expected":"\"CORAL\""}`. For known extraction paths, prefer local `execute` rather than paying a model to reproduce a computable answer.

MCP `invoke_prompt` accepts `outputShape: {"type":"string"}`; `get_runtime_decision` and `explain_fallback` accept the same option for accurate inspection. SDK construction:

```ts
const adapter = new OpenAIAdapter(model, {
  provider: "openrouter", apiKey, price,
  outputShape: { type: "string" },
});
const router = new RuntimeRouter(adapter, store);
const result = await router.invoke(prompt, {
  maxOutputTokens: 128,
  responseContract: { kind: "exact_json", expected: JSON.stringify(trustedValue) },
});
// result.outputText is validated JSON; result.response.text preserves the wire response.
```

No output shape is inferred from the reference, enabled globally or retroactively applied to old experiments. Plain-text mode is unchanged. The native option currently requires OpenRouter; other adapters must not silently ignore it. Contradictory native shapes and response references fail before inference. Known incomplete responses and invalid envelopes are rejected after recording available usage/cost, even without an oracle.

## Cost, calibration and failures

The output wrapper, system instruction and schema can increase token usage. Preflight includes their serialized bytes in its conservative reservation; actual provider usage includes the full request/response. This correction makes **no new savings or model-quality claim**. It has been checked offline using mocked providers and the preserved real failure; no new paid validation was run for the native protocol.

The fixed shape and protocol are part of the adapter fingerprint. A profile calibrated for ordinary text or a different shape cannot authorize compression for this format. CLI `calibrate` / `benchmark` accepts `--output-shape` with a custom suite of compatible `exact_json` oracles; the SDK optimizer also supports a shaped adapter. All scored expectations are validated before spending. Both baseline and candidate use the identical protocol; complete billed usage is compared. Built-in suites use legacy text oracles and cannot be used for this calibration. MCP's built-in calibration tools remain for those ordinary suites.

When a compiled runtime answer fails its trusted response contract or required output validation, that profile is marked `needs_reverification`. A subsequent request routes to the original until recalibration. The failing response's bill is still recorded, and no automatic paid retry occurs. This is conservative containment of observed failure, not proof the codec caused it. Read-only routing inspection does not mutate profiles. Provider transport errors alone still do not establish a quality failure.

Regression tests cover the captured wrong object, correct and wrong values inside the wrapper, extra/duplicate keys, fences, truncation, no-oracle rejection, unsupported-provider errors, no reference leakage, shape-specific fingerprints, budget overhead, decoded benchmark scoring, generated strings, and CLI/MCP propagation. Historical paid evidence and its original scores remain unchanged.
