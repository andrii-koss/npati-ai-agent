import { C3_TERMINAL_CASES } from "./c3-terminal-proof";
import { runC3CrashChild, checkC3WorkerCrash } from "./c3-worker-crash-proof";
import { createC3ProofFixture, C3_PROOF_CASES, checkPosixModes } from "./c3-workspace-proof";
(async () => {
  const crashIndex = process.argv.indexOf("--c3-crash-child");
  if (crashIndex >= 0) { await runC3CrashChild(process.argv[crashIndex + 1]!, process.argv[crashIndex + 2]!); return; }
  const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const [name, check] of [...Object.entries(C3_PROOF_CASES), ...Object.entries(C3_TERMINAL_CASES), ["POSIX ordinary and executable modes survive edits and failed-delete rollback", checkPosixModes] as const]) {
    const fixture = await createC3ProofFixture();
    try { await check(fixture); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "Check failed" }); }
    finally { await fixture.cleanup(); }
  }
  for (const stage of ["staging", "after-first", "after-second"]) {
    const fixture = await createC3ProofFixture();
    const name = "worker crash recovery: " + stage;
    try { await checkC3WorkerCrash(fixture, process.argv[1]!, stage); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "Check failed" }); }
    finally { await fixture.cleanup(); }
  }
  const passed = checks.every(check => check.passed);
  console.log(JSON.stringify({ kind: "real-linux-canonical-workspace-and-git", uid: process.getuid?.(), providerCalls: 0, checks, passed }));
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
