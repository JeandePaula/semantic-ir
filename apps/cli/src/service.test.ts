import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "@semantic-ir/engine";
import { adapterFor, providerFor, providerKey, saveProviderKey } from "./service.js";

describe("provider configuration", () => {
  it("loads a private OpenRouter key file without storing the key in SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-ir-secret-"));
    const file = join(dir, "openrouter.key");
    const originalPath = process.env.OPENROUTER_API_KEY_FILE;
    const originalKey = process.env.OPENROUTER_API_KEY;
    const store = new SqliteStore(":memory:");
    try {
      process.env.OPENROUTER_API_KEY_FILE = file;
      delete process.env.OPENROUTER_API_KEY;
      expect(saveProviderKey("openrouter", "fixture-secret")).toBe(file);
      store.setSetting("defaultProvider", "openrouter");
      expect(providerFor(store)).toBe("openrouter");
      expect(providerKey("openrouter")).toBe("fixture-secret");
      expect((await adapterFor(store, "z-ai/glm-5.3-flash").getModelFingerprint()).provider)
        .toBe("openrouter");
      expect(store.getSetting("openrouterKey")).toBeNull();
    } finally {
      store.close();
      if (originalPath === undefined) delete process.env.OPENROUTER_API_KEY_FILE;
      else process.env.OPENROUTER_API_KEY_FILE = originalPath;
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
