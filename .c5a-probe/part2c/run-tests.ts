/**
 * Runs the real C5a spec files through the local `vitest` shim (verification aid, not a deliverable).
 *
 *   node --experimental-transform-types --import ./.c5a-probe/part2c/register.mjs .c5a-probe/part2c/run-tests.ts
 *
 * Every `it` of every listed file is executed against its own assertions; the script prints
 * `passed/failed` per file and exits non-zero when anything failed.
 */
import { __registry, __reset } from "./vitest.mjs";

const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["tests/coding-agent-c5a-protected-branches.test.ts", "tests/coding-agent-c5a-role-escalation.test.ts"];

let totalPassed = 0;
let totalFailed = 0;

for (const file of FILES) {
  __reset();
  const specifier = `../../${file.replace(/\\/g, "/")}`;
  try {
    await import(specifier);
  } catch (error) {
    totalFailed += 1;
    console.log(`${file}: passed=0 failed=1`);
    console.log(`  LOAD ERROR ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const tests = [...__registry()];
  let passed = 0;
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
    } catch (error) {
      failures.push({ name: entry.name, error });
    }
  }
  totalPassed += passed;
  totalFailed += failures.length;
  console.log(`${file}: passed=${passed} failed=${failures.length}`);
  for (const failure of failures) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    console.log(`  FAILED ${failure.name}\n    ${message.split("\n").slice(0, 6).join("\n    ")}`);
  }
}

console.log(`\nharness: passed=${totalPassed} failed=${totalFailed}`);
process.exit(totalFailed === 0 ? 0 : 1);
