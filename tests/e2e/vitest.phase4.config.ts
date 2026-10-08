import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["phase4/**/*.test.ts"],
    setupFiles: ["phase4/setup-env.ts"],
    // Every file starts the whole stack on the same ports and shares one broker and its consumer
    // groups, so the files run one at a time.
    fileParallelism: false,
    // A hard-killed consumer is only replaced after the group's session timeout (45s), and the
    // payment service waits out a 30s stale-PROCESSING window, so recovery is measured in tens of seconds.
    testTimeout: 600_000,
    hookTimeout: 360_000,
  },
});
