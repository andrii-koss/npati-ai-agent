import { createC3ProofFixture, C3_PROOF_CASES, checkPosixModes } from "./c3-workspace-proof";
(async () => {
  const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const [name, check] of [...Object.entries(C3_PROOF_CASES), ["POSIX executable mode survives canonical edit", checkPosixModes] as const]) {
    const fixture = await createC3ProofFixture();
    try { await check(fixture); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "Check failed" }); }
    finally { await fixture.cleanup(); }
  }
  const passed = checks.every(check => check.passed);
  console.log(JSON.stringify({ kind: "real-linux-canonical-workspace-and-git", uid: process.getuid?.(), providerCalls: 0, checks, passed }));
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
