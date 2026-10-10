import { defineConfig } from "vitest/config";

// Resolve @flash/* straight to package sources via tsconfig paths, so tests never need a prior build.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // The Redis-backed files run one after another: the admitter tests measure an admit rate on a
    // 100ms timer, which other files competing for the event loop's CPU would skew.
    fileParallelism: false,
  },
});
