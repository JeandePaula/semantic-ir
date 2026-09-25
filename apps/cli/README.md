# Semantic IR CLI

Local CLI, MCP server and gateway for source preserving prompt analysis and controlled codec experiments.

Requires Node.js 24 or newer. Run `semantic-ir help`, then `semantic-ir init` and `semantic-ir doctor`. `semantic-ir integrations build --out ./dist` exports Codex, Claude Code and generic MCP packages. The plugin MCP command is `semantic-ir mcp`.

Provider calls require your own `OPENAI_API_KEY`. Paid calibration additionally requires `--allow-spend` plus explicit request, token, USD and duration limits. No verified savings are claimed by this package. The built in benchmark only scores synthetic exact extraction cases; other tasks require a custom scored suite. Profiles and metrics are kept locally in SQLite.

The repository README and `docs/` contain test, integration and release procedures. License: MIT.
