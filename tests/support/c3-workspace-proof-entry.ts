import { C3_TERMINAL_CASES } from "./c3-terminal-proof";
import { runC3CrashChild, checkC3WorkerCrash, checkPausedKernelWriter } from "./c3-worker-crash-proof";
import { createC3ProofFixture, C3_PROOF_CASES, checkPosixModes } from "./c3-workspace-proof";
(async () => {
  const crashIndex = process.argv.indexOf("--c3-crash-child");
  if (crashIndex >= 0) { await runC3CrashChild(process.argv[crashIndex + 1]!, process.argv[crashIndex + 2]!); return; }
  const caseIndex = process.argv.indexOf("--case");
  const selectedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
  const cases = [...Object.entries(C3_PROOF_CASES), ...Object.entries(C3_TERMINAL_CASES), ["POSIX ordinary and executable modes survive edits and failed-delete rollback", checkPosixModes] as const];
  if (caseIndex >= 0 && (!selectedCase || !cases.some(([name]) => name === selectedCase))) throw new Error("Unknown audit case");
  const checks: Array<{ name: string; passed: boolean; durationMs?: number; error?: string }> = [];
  for (const [name, check] of cases.filter(([name]) => !selectedCase || name === selectedCase)) {
    const fixture = await createC3ProofFixture();
    const checkStarted = Date.now();
    try { await check(fixture); checks.push({ name, passed: true, durationMs: Date.now() - checkStarted }); }
    catch (error) { checks.push({ name, passed: false, durationMs: Date.now() - checkStarted, error: error instanceof Error ? error.message : "Check failed" }); }
    finally { await fixture.cleanup(); }
  }
  for (const stage of selectedCase ? [] : ["staging", "after-first", "after-second", "after-first-immediate", "kill-after-first", "terminal-after-first", "kill-during-rollback"]) {
    const fixture = await createC3ProofFixture();
    const checkStarted = Date.now();
    const name = "worker crash recovery: " + stage;
    try { await checkC3WorkerCrash(fixture, process.argv[1]!, stage); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "Check failed" }); }
    finally { await fixture.cleanup(); }
  }
  if (!selectedCase) {
    const fixture = await createC3ProofFixture(), name = "paused worker retains kernel fence despite expired heartbeat", checkStarted = Date.now();
    try { await checkPausedKernelWriter(fixture, process.argv[1]!); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "Check failed" }); }
    finally { await fixture.cleanup(); }
  }
  const passed = checks.every(check => check.passed);
  console.log(JSON.stringify({ kind: "real-linux-canonical-workspace-and-git", uid: process.getuid?.(), selectedCase: selectedCase ?? null, providerCalls: 0, checks, passed }));
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
