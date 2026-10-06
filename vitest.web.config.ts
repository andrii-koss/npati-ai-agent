import { defineConfig } from "vitest/config";

/**
 * C7: the front-end test project.
 *
 * Why a second config instead of a `projects` entry in `vitest.config.ts`: the root config's `include`
 * lists exactly `tests/**` and `packages/**`, and `npm run security-gate` asserts the composition of that
 * fixed suite list (65 suites). Editing the root config would put those suites — and the gate itself — at
 * risk for a UI-only concern, so web tests live here and run through `npm run test:web`.
 *
 * `environment: "node"` is deliberate: jsdom and @testing-library/react are **not** installed in this
 * repository, and this stream must not pretend otherwise. The components are presentational and rendered
 * with `react-dom/server`'s `renderToStaticMarkup`, which is exactly what the security-relevant
 * assertions need (a payload must appear as escaped text rather than markup); interaction semantics are
 * covered by the pure request mapping in `actions.ts`. Click-through tests with jsdom + RTL are a
 * deliberate follow-up, not something silently skipped here.
 */
export default defineConfig({
  test: {
    include: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
    environment: "node",
    testTimeout: 10_000,
    maxWorkers: 2,
  },
});
