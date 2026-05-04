/**
 * tsdown.config.ts
 *
 * Library bundler powered by Rolldown (Rust). In a single pass it:
 *  - Outputs dist/main.mjs   (ESM, tree-shakeable)
 *  - Outputs dist/main.cjs   (CommonJS, for older toolchains)
 *  - Outputs dist/main.d.mts (bundled type declarations for ESM)
 *  - Outputs dist/main.d.cts (bundled type declarations for CJS)
 *
 * All entries in `dependencies` and `peerDependencies` are automatically
 * externalised by tsdown so they are never inlined into the bundle.
 */

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: true,
  platform: "node",
  treeshake: true,
});
