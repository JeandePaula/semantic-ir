import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "apps", "cli", "assets", "integrations");
const codexRoot = join(output, "codex");
const claudeRoot = join(output, "claude-code");
await mkdir(join(codexRoot, "plugins"), { recursive: true });
await mkdir(join(claudeRoot, "plugins"), { recursive: true });
await cp(join(root, "integrations", "codex"), join(codexRoot, "plugins", "semantic-ir"), { recursive: true, force: true });
await cp(join(root, "integrations", "claude-code"), join(claudeRoot, "plugins", "semantic-ir"), { recursive: true, force: true });
await cp(join(root, "integrations", "generic-mcp"), join(output, "generic-mcp"), { recursive: true, force: true });
await mkdir(join(codexRoot, ".agents", "plugins"), { recursive: true });
await mkdir(join(claudeRoot, ".claude-plugin"), { recursive: true });
await writeFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
  name: "semantic-ir-local",
  interface: { displayName: "Semantic IR Local" },
  plugins: [{
    name: "semantic-ir",
    source: { source: "local", path: "./plugins/semantic-ir" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  }],
}, null, 2) + "\n");
await writeFile(join(claudeRoot, ".claude-plugin", "marketplace.json"), JSON.stringify({
  name: "semantic-ir-local",
  owner: { name: "Semantic IR contributors" },
  plugins: [{
    name: "semantic-ir",
    source: "./plugins/semantic-ir",
    description: "Semantic prompt analysis and controlled downstream optimization.",
  }],
}, null, 2) + "\n");
