import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [{
    name: "npati-sql-migrations",
    enforce: "pre",
    load(id) {
      if (!id.endsWith(".sql")) return null;
      return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    },
  }],
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    // Bound parallel transforms and app instances so CI runners do not exhaust
    // memory or starve HTTP integration tests on high-core hosts.
    maxWorkers: 8,
  },
});
