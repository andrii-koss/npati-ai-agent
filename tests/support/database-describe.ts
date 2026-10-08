/**
 * G1 (item 2/3): the conditional `describe` of a database-backed gate suite.
 *
 * A DB suite must be *skipped* under `npm test` (which has no database and must keep its 10 files / 15 tests
 * baseline) and must *run* under its own gate (`npm run security-gate:db`, `npm run gate:upgrade:db`), so it picks
 * `describe` or `describe.skip` at load time. Two things make that worth a helper rather than an inline ternary:
 *
 *  - the condition is the same in both suites (a `DATABASE_URL` **and** the `NPATI_SECURITY_GATE_DB=1` marker the
 *    gate scripts set), so it is written once;
 *  - `describe.skip` is not part of every runner this repository uses. The local probe harness
 *    (`artifacts/c5b-policy-probe/vitest.mjs`) implements only the vitest API its own suites need, so
 *    `describe.skip` is `undefined` there — and `undefined(...)` fails while the file is being **loaded**, which
 *    reads as "this suite is broken" instead of "this suite is the DB gate and this run has no database". The
 *    helper falls back to a refusal that names the command to run.
 */

/** The subset of vitest's `describe` a suite needs: a name and a synchronous body. */
export type DescribeBlock = (name: string, body: () => void) => void;

/** `describe` when the database gate is running, `describe.skip` (or a named refusal) when it is not. */
export function databaseDescribe(enabled: boolean, run: DescribeBlock, skip: DescribeBlock): DescribeBlock {
  return enabled ? run : skip;
}

/** The `skip` argument for a runner that has no `describe.skip`: loading the file must say what to run. */
export function missingDatabaseSkip(name: string): never {
  throw new Error(
    `${name}: this is a database-backed suite and the runner in use has no \`describe.skip\`. ` +
      "Run it through its own gate, which requires DATABASE_URL and is never skipped: " +
      "`npm run security-gate:db` (audit journal) or `npm run gate:upgrade:db` (migration chain).",
  );
}
