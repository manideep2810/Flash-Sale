import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every file starts its own ticket, relay and order services on the same ports and shares one
    // broker and one consumer group with the others, so the files run one at a time.
    fileParallelism: false,
    // Recovery from a hard kill is measured in tens of seconds; see chaos.test.ts.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
