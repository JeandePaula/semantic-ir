# Semantic IR CLI

Local CLI, MCP server and gateway for source preserving prompt analysis and controlled codec experiments.

Requires Node.js 24 or newer. Run `semantic-ir help`, then `semantic-ir init` and `semantic-ir doctor`. `semantic-ir integrations build --out ./dist` exports Codex, Claude Code and generic MCP packages. The plugin MCP command is `semantic-ir mcp`.

Provider calls require your own `OPENAI_API_KEY` or `OPENROUTER_API_KEY`. `semantic-ir credentials import --provider openrouter` accepts a key on stdin and stores it in a private `~/.config/semantic-ir/openrouter.key` file (mode `0600`). Configure OpenRouter with `semantic-ir configure --provider openrouter --model z-ai/glm-5.3-flash`, then test with `semantic-ir invoke --allow-spend --max-output-tokens 256 --prompt "Say OK"`. Paid calibration is available only where verified pre-counting exists and additionally requires explicit request, token, USD and duration limits. No verified savings are claimed by this package. The built in benchmark only scores synthetic exact extraction cases. Profiles and metrics are kept locally in SQLite.

The repository README and `docs/` contain test, integration and release procedures. License: MIT.
