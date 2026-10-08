/**
 * G1 (item 2): the teardown contract of the DB-backed gate suites.
 *
 * The defect this module removes is a **masking** one, and it is worth stating exactly, because the symptom
 * looked like a missing method:
 *
 *   `finally { await pool.end(); await store.close(); }`
 *
 * `store.close` did not exist anywhere in the repository. A `TypeError` raised in `finally` **replaces** the
 * exception (or the failed assertion) that was propagating from `try`, so the suite reported
 * `TypeError: store.close is not a function` — the teardown — while the real failing assertion was never
 * printed. Nine escalated runs of the security gate were spent reading the symptom.
 *
 * `runWithCleanup` makes the body's verdict the one that survives:
 *
 *  - the body's error is always the error that is thrown;
 *  - a cleanup failure is **appended** to it rather than substituted for it, so neither error is lost;
 *  - when the body passes and only the cleanup fails, that failure is thrown (a broken teardown is still a
 *    broken test, so it cannot be swallowed either).
 *
 * The behaviour is pinned hermetically by `tests/coding-agent-c4a-security-gate.test.ts`, which is a suite of
 * the hermetic security gate — so the property is asserted even on a machine with no database at all.
 */

/** One line naming an error, for a message that has to carry two of them. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Runs `body` and then `cleanup`, and reports both. The body's error is thrown first and never replaced;
 * a cleanup error that accompanies it is appended to the message instead of being thrown in its place.
 */
export async function runWithCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value: T | undefined;
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    value = await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (bodyFailed) {
    if (cleanupFailed && bodyError instanceof Error) {
      // The body error explains the test, so it stays the thrown error; the cleanup failure is appended
      // rather than dropped. Throwing the cleanup error here — or letting it escape a `finally` — is
      // precisely the masking this helper was written to remove.
      bodyError.message = `${bodyError.message}\n[cleanup also failed] ${describeError(cleanupError)}`;
    }
    throw bodyError;
  }
  if (cleanupFailed) throw cleanupError;
  return value as T;
}
