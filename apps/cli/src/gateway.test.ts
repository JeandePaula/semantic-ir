import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SqliteStore } from "@semantic-ir/engine";
import { createGateway } from "./gateway.js";

describe("gateway", () => {
  it("routes supported text and forwards unsupported chat bodies unchanged", async () => {
    const nativeFetch = fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture";
    const sent: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body)) as unknown;
      sent.push({ path, body });
      if (path === "/v1/responses") {
        return new Response(JSON.stringify({
          id: "resp_1", model: "test", status: "completed",
          output: [{ content: [{ type: "output_text", text: "8500" }] }],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "chat_1", choices: [] }), { status: 200 });
    }));
    const store = new SqliteStore(":memory:");
    const server = createGateway(store);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local address");
    const endpoint = "http://127.0.0.1:" + address.port + "/v1/chat/completions";
    try {
      const supported = await nativeFetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "Extract 8500" }] }),
      });
      expect(supported.status).toBe(200);
      const supportedBody = await supported.json() as { choices: Array<{ message: { content: string } }> };
      expect(supportedBody.choices[0]?.message.content).toBe("8500");
      expect(sent[0]?.path).toBe("/v1/responses");

      const unsupportedBody = {
        model: "test", messages: [
          { role: "system", content: "Keep the exact system instruction" },
          { role: "user", content: "Hello" },
        ], tools: [{ type: "function", function: { name: "noop", parameters: {} } }],
      };
      const passthrough = await nativeFetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(unsupportedBody),
      });
      expect(passthrough.status).toBe(200);
      expect(sent[1]).toEqual({ path: "/v1/chat/completions", body: unsupportedBody });
      expect(store.metricsSummary()).toMatchObject({
        requests: 2, fallbacks: 2,
        byScope: [{ scope: "application_request", requests: 2 }],
      });
      const dashboard = await nativeFetch(endpoint.replace("/v1/chat/completions", "/dashboard"));
      expect(await dashboard.text()).toContain("Verified savings: unavailable");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      vi.unstubAllGlobals();
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
