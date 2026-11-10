import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
    exclude: ["**/node_modules/**", ".codex-snapshots/**", "reference/**"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
