/**
 * vitest.config.ts
 *
 * Vitest configuration for the ai-sdk-github-copilot provider test suite.
 *
 * Uses the Node environment so the tests run against the same Node.js API
 * surface that the library targets.
 */

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@utils": path.resolve(import.meta.dirname, "src/utils"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
