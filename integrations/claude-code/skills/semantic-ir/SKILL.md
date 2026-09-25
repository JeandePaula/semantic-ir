---
name: semantic-ir
description: Inspect prompt fidelity and profiles, or make explicitly authorized downstream LLM calls with Semantic IR.
---

Use the Semantic IR MCP server for analysis, deterministic checks, profile lookup, metrics, and fallback explanations.

This skill does not replace Claude Code's primary prompt before inference. Describe host primary prompt optimization as unavailable unless a verified host capability changes. Attribute savings only to controlled downstream or application calls.

For a real provider call, use `invoke_prompt` only after the user explicitly authorizes spending. Supply `allowSpend: true`, a positive `maxOutputTokens`, and the prompt. Report the response, usage, cost when available, and routing decision. With no stable profile, the original prompt is used.

Before calling a calibration or benchmark tool, obtain explicit authorization for provider spending and provide request, token, cost, and duration caps. For OpenRouter closed extraction cases, `suite: "redundant-extraction"` is available. Inspect `get_calibration_report`; distinguish `promoted`, measured holdout sample savings, and production savings. A conservative byte envelope is not an absolute USD guarantee; recommend a provider-side key limit. If there is no trusted success oracle or cost measurement, report the result as unavailable.
