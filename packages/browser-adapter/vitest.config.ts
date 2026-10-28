import { defineConfig } from "vitest/config";

// Real browser tests: launching Chromium takes a few seconds.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
