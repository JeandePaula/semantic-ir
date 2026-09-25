---
name: semantic-ir
description: Analyze prompt fidelity, inspect profiles, or make explicitly authorized downstream LLM calls with Semantic IR.
---

Use the Semantic IR MCP tools for source-preserving analysis, deterministic literal checks, profile status, and measured downstream calls.

Start with `doctor` and `get_runtime_decision` when a user asks whether optimization is active. Explain the fallback reason and optimization scope. The plugin does not claim control of Codex's primary prompt before inference.

For a real model call, use `invoke_prompt` only after the user explicitly authorizes spending. Set `allowSpend: true` and a positive `maxOutputTokens`; report the provider response, usage, cost when available, and routing decision. A missing stable profile means the original prompt is used.

Call `calibrate_model` or `benchmark_codec` only after the user explicitly authorizes provider spending and supplies request, token, cost, and duration limits. For OpenRouter closed extraction cases, `suite: "redundant-extraction"` is available; report `promoted`, `holdoutEvidence`, and `run.budgetMethod` from `get_calibration_report`. A conservative byte envelope is an estimated local ceiling, so recommend a provider-side key spending limit for an external cap. Never generalize sample savings to other tasks or invent quality scores.

For controlled application calls, use the Semantic IR gateway. Keep API keys in the user's environment or the CLI's private credential file, outside plugin files and tool outputs.
