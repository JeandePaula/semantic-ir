---
name: semantic-ir
description: Analyze prompt fidelity, inspect model profiles, or benchmark Semantic IR codecs for downstream LLM calls.
---

Use the Semantic IR MCP tools for source-preserving analysis, deterministic literal checks, profile status, and measured downstream experiments.

Start with `doctor` and `get_runtime_decision` when a user asks whether optimization is active. Explain the fallback reason and optimization scope. The plugin does not claim control of Codex's primary prompt before inference.

Call `calibrate_model` or `benchmark_codec` only after the user explicitly authorizes provider spending and supplies request, token, cost, and duration limits. Never invent savings or quality scores. When evidence is unavailable, report it as unavailable.

For controlled application calls, use the Semantic IR gateway. Keep API keys in the user's environment or the CLI's private credential file, outside plugin files and tool outputs.
