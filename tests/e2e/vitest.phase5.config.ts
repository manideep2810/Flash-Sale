import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["phase5/**/*.test.ts"],
    // Every file starts the ticket service, queue-svc and the admitter on the same ports, so the
    // files run one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    // Three processes started under tsx.
    hookTimeout: 90_000,
  },
});
