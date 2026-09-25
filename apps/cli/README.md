# Semantic IR CLI

Local CLI, MCP server and gateway for source preserving prompt analysis and controlled codec experiments.

Requires Node.js 24 or newer. Run `semantic-ir help`, then `semantic-ir init` and `semantic-ir doctor`. `semantic-ir integrations build --out ./dist` exports Codex, Claude Code, Google Antigravity and generic MCP packages. The plugin MCP command is `semantic-ir mcp`. On Windows with a WSL runtime, pass `--wsl-distro NAME` to generate host packages that launch the WSL MCP server.

Provider calls require your own `OPENAI_API_KEY` or `OPENROUTER_API_KEY`. `semantic-ir credentials import --provider openrouter` accepts a key on stdin and stores it in a private `~/.config/semantic-ir/openrouter.key` file (mode `0600`). Configure OpenRouter with `semantic-ir configure --provider openrouter --model z-ai/glm-5.3-flash`, then try `semantic-ir invoke --allow-spend --max-output-tokens 256 --prompt "Say OK"`. Inside an installed plugin, use the MCP tool `invoke_prompt` with `allowSpend: true` and `maxOutputTokens`.

OpenRouter calibration uses a conservative byte-based budget estimate and provider-measured cost; it does not claim exact pre-counting or an absolute local USD cap. Set an OpenRouter key spending limit for an external cap. Run `semantic-ir calibrate --model z-ai/glm-5.3-flash --task extraction --suite redundant-extraction --allow-spend --max-requests 36 --max-tokens 60000 --max-cost-usd 0.05 --max-duration-ms 900000 --max-output-tokens 256`, then inspect `semantic-ir calibration report`. The built-in suites cover closed extraction tasks only. Savings from a holdout sample are not production savings. Profiles, reports and metrics are kept locally in SQLite.

The repository README and `docs/` contain test, integration and release procedures. License: MIT.
