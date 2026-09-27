import { defineConfig } from "vitest/config";

// Resolve @flash/* straight to package sources via tsconfig paths, so tests never need a prior build.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});
