import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/worker.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  clean: true,
  sourcemap: true,
  noExternal: [/^@npati\//, "exceljs"],
  external: ["pg", "redis"],
  loader: { ".sql": "text" },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; var require = __createRequire(import.meta.url);",
  },
});
