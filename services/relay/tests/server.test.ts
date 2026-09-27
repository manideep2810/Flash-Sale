import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createLogger } from "@flash/observability";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

describe("relay server", () => {
  it("boots and answers the health probes", async () => {
    const app = createApp(createLogger({ service: "relay", level: "error" }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const live = await fetch(`http://127.0.0.1:${port}/healthz/live`);
      const ready = await fetch(`http://127.0.0.1:${port}/healthz/ready`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ ok: true });
      expect(ready.status).toBe(200);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
