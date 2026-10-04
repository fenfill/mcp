import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Package tests run the sources in Node. `@` → the repo root, so the stamping
// core (`@/app/t/[template_id]/fillCore`) resolves exactly as the bundle does.
export default defineConfig({
  resolve: {
    alias: { "@": resolve(dirname(fileURLToPath(import.meta.url)), "../..") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
