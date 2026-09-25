import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../apps/cli/bundle/", import.meta.url));
await mkdir(target, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../apps/cli/src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../apps/cli/bundle/main.js", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@modelcontextprotocol/sdk/*", "zod"],
});
