import { describe, it } from "vitest";
import { createC3ProofFixture, C3_PROOF_CASES } from "./support/c3-workspace-proof";
describe("security-gate: C3 real Workspace and Git integration", () => {
  for (const [name, check] of Object.entries(C3_PROOF_CASES)) {
    it(name, async () => {
      const fixture = await createC3ProofFixture();
      try { await check(fixture); } finally { await fixture.cleanup(); }
    }, 30000);
  }
});
