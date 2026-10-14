import { defineConfig } from "vitest/config";

/**
 * C7: the front-end test project.
 *
 * Why a second config instead of a `projects` entry in `vitest.config.ts`: the root config's `include`
 * lists exactly `tests/**` and `packages/**`, and `npm run security-gate` asserts the composition of that
 * fixed suite list (65 suites). Editing the root config would put those suites — and the gate itself — at
 * risk for a UI-only concern, so web tests live here and run through `npm run test:web`.
 *
 * Node remains the default for SSR/security tests. Interaction suites opt into jsdom
 * with a file-level environment annotation and exercise native buttons and clipboard behavior.
 */
export default defineConfig({
  test: {
    include: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
    environment: "node",
    testTimeout: 10_000,
    maxWorkers: 2,
  },
});
