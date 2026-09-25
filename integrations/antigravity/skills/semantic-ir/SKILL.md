---
name: semantic-ir
description: Analyze prompt fidelity and make explicitly authorized, measured downstream LLM calls with Semantic IR.
---

Use the Semantic IR MCP tools when a user asks to inspect a prompt, check a profile, or route a downstream LLM call through Semantic IR. Run `doctor` first to verify the provider and private API key configuration.

For a real provider call, use `invoke_prompt` only when the user explicitly authorizes spending. Supply `allowSpend: true`, the user's prompt, and a positive `maxOutputTokens`. Report the provider response, usage, cost when available, and routing decision. A missing stable profile means the original prompt is used.

The plugin cannot replace Antigravity's own primary prompt before inference. Describe that scope as unavailable, and do not claim savings without measured evidence. Keep API keys outside plugin files and tool output.

For explicit paid calibration, require request, token, USD, and duration limits. `suite: "redundant-extraction"` evaluates closed extraction cases on OpenRouter. Read `get_calibration_report` afterward and distinguish holdout sample results from production savings. A conservative byte envelope is not a hard provider billing cap.
