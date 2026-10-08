/**
 * G1 probe: the three properties of the auth provider's lazy initialization, driven through the **real**
 * provider (`vitest` cannot start in the agent sandbox, and `tests/auth-single-flight.test.ts` declares one of its
 * two cases as a top-level `it`, which the local probe harness refuses by construction).
 *
 * 1. a transient failure is retried by the next request (`initialize` twice for two requests) — the contract
 *    `tests/auth-single-flight.test.ts` pins;
 * 2. concurrent requests single-flight into one attempt;
 * 3. after the attempt budget is spent the negative cache holds, so a broken database is not retried per request.
 *
 * Read-only: it creates no file, opens no socket and touches no database.
 */
import { register } from "node:module";

register(new URL("../artifacts/c5b-policy-probe/loader.mjs", import.meta.url));
const { NpatiBackendAuthProvider, createMockNpatiJwt } = await import("../apps/agent-api/src/auth.ts");

const failures = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${actual} (expected ${expected})`);
  if (!ok) failures.push(label);
};

const request = (secret, userId) => ({ headers: { authorization: `Bearer ${createMockNpatiJwt({ userId }, secret)}` } });

// 1. Retry contract: the first attempt fails, the second request retries it.
{
  const secret = "single-flight-retry-secret-thirty-two-characters";
  let calls = 0;
  const reports = [];
  const provider = new NpatiBackendAuthProvider({
    jwtSecret: secret,
    workspaceStore: { initialize: async () => { calls += 1; if (calls === 1) throw new Error("database unavailable"); } },
    onWorkspaceInitFailure: (failure) => reports.push(failure),
  });
  await provider.authenticate(request(secret, "retry-user"));
  await provider.authenticate(request(secret, "retry-user"));
  check("retry contract: initialize calls", calls, 2);
  check("retry contract: reported failures", reports.length, 1);
  check("retry contract: first report has no negative cache", reports[0]?.retryAfter, null);
  check("retry contract: workspace initialized after the success", provider.isWorkspaceInitialized("workspace:retry-user"), true);
}

// 2. Single-flight: 1000 concurrent requests for one workspace initialize it once.
{
  const secret = "single-flight-secret-at-least-thirty-two-characters";
  let calls = 0;
  const provider = new NpatiBackendAuthProvider({
    jwtSecret: secret,
    workspaceStore: { initialize: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); } },
  });
  const contexts = await Promise.all(Array.from({ length: 1000 }, () => provider.authenticate(request(secret, "concurrent-user"))));
  check("single flight: initialize calls", calls, 1);
  check("single flight: one workspace", new Set(contexts.map((context) => context.workspaceId)).size, 1);
}

// 3. Negative cache: two failed attempts, then six requests in total never try a third time immediately.
{
  const secret = "negative-cache-secret-at-least-thirty-two-characters";
  let calls = 0;
  const reports = [];
  const provider = new NpatiBackendAuthProvider({
    jwtSecret: secret,
    workspaceStore: { initialize: async () => { calls += 1; throw new Error('migration 014 failed: extension "vector" is not available'); } },
    onWorkspaceInitFailure: (failure) => reports.push(failure),
    workspaceInitMaxAttempts: 2,
    workspaceInitRetryMs: 60_000,
  });
  for (let attempt = 0; attempt < 6; attempt += 1) await provider.authenticate(request(secret, "cached-user"));
  check("negative cache: initialize calls", calls, 2);
  check("negative cache: reported attempts", reports.map((failure) => failure.attempts).join(","), "1,2");
  check("negative cache: a reason is carried", reports[0]?.message.includes('extension "vector" is not available'), true);
  check("negative cache: retryAfter is set", typeof provider.workspaceInitializationFailures()[0]?.retryAfter, "number");
}

console.log(failures.length === 0 ? "PROBE: all properties hold" : `PROBE: FAILED (${failures.join(", ")})`);
process.exit(failures.length === 0 ? 0 : 1);
