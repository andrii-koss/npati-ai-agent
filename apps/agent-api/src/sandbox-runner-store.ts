import type { WorkspaceStore } from "@npati/workspace";

/**
 * G1 (item 4): how the sandbox runner resolves the workspace store it reads its catalogue and confirmed mounts
 * from — and what it says when that store cannot be initialized.
 *
 * The defect this replaces was:
 *
 *   `await postgres.initialize().catch((error) => console.error(…))`
 *
 * Three things were wrong with it, and only the first is obvious. The failure was reported through a bare
 * `console.error` with no state anywhere; the runner then returned the **uninitialized** PostgreSQL store marked
 * `database: true`, so every later read failed one at a time and nothing ever said "the store is unavailable";
 * and the whole decision was unreachable from a test, because it lived inside a module that starts an HTTP
 * server at import time.
 *
 * Here the decision is a function of injected factories and a reporter, so it is testable without Docker, without
 * a database and without starting the runner: a failed initialization produces `failure` (the reason, verbatim),
 * a structured notice, and an admission path that refuses instead of querying a store that cannot answer. A
 * missing `DATABASE_URL` is a **different** outcome — a deliberate fallback to the in-memory store, which cannot
 * see a revocation issued through the API — and it is reported as such rather than as an initialization failure.
 */
export interface RunnerStoreNotice {
  event: "runner_store_not_configured" | "runner_store_unavailable";
  code: "runner_store_not_configured" | "runner_store_unavailable";
  message: string;
  /** Whether this resolution was supposed to be database-backed. */
  database: boolean;
}

export interface RunnerStoreResolution {
  store: WorkspaceStore;
  database: boolean;
  /** `null` when the store is usable; otherwise the reason initialization failed, verbatim. */
  failure: string | null;
}

export interface RunnerStoreInput {
  /** `DATABASE_URL` (or its documented alias) — `undefined` selects the in-memory fallback. */
  databaseUrl?: string;
  createPostgresStore: (databaseUrl: string) => WorkspaceStore;
  createMemoryStore: () => WorkspaceStore;
  /** Where the notice goes. The caller decides the level: `unavailable` is an error, `not_configured` a warning. */
  report: (notice: RunnerStoreNotice) => void;
}

export async function resolveRunnerStore(input: RunnerStoreInput): Promise<RunnerStoreResolution> {
  if (input.databaseUrl) {
    const store = input.createPostgresStore(input.databaseUrl);
    try {
      await store.initialize();
      return { store, database: true, failure: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.report({
        event: "runner_store_unavailable",
        code: "runner_store_unavailable",
        message: `the runner's workspace store could not be initialized: ${message}`,
        database: true,
      });
      return { store, database: true, failure: message };
    }
  }
  const store = input.createMemoryStore();
  await store.initialize();
  input.report({
    event: "runner_store_not_configured",
    code: "runner_store_not_configured",
    message: "DATABASE_URL is not set: image revocations issued through the API are not visible to this runner",
    database: false,
  });
  return { store, database: false, failure: null };
}
