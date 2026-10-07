import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, WorkspaceNotFoundError } from "@npati/workspace";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CodeRunStateLog, type CodeRunStateStorePort } from "../apps/agent-api/src/code-run-state";
import { CodeSessionResumeService, readImageVerdict, type CodeSessionResumeDeps } from "../apps/agent-api/src/code-session-resume";
import {
  createResumeEnvironmentAdmission,
  RESUME_ENVIRONMENT_DIFF_FAMILIES,
  RESUME_ENVIRONMENT_FAMILIES,
  type ResumeEnvironmentSources,
} from "../apps/agent-api/src/execution-snapshot";

/**
 * C10 security-gate suite: **a resume does not continue silently in a moved environment**.
 *
 * A run is admitted in an environment: a set of resolved feature flags, a policy composition, a provider/data
 * policy and one sandbox image digest. The run's `ExecutionSnapshot` records it. By the time somebody resumes,
 * the process that ran it is gone and every one of those facts may have moved — a flag was flipped, the policy
 * version was bumped, the classification was raised, the image was **revoked**.
 *
 * What is pinned here:
 *
 *  1. **A resume records a NEW snapshot version** (`trigger: "resume"`) built from the facts a resume can
 *     genuinely re-read, and hands the caller the **store's own** content-safe diff against the snapshot the run
 *     was admitted under. There is no second snapshot mechanism: the same payload assembler, the same secret
 *     scan, the same versioning store and the same `diffExecutionSnapshots`.
 *  2. **A changed environment is stated, not swallowed.** The diff travels in the response *and* into the
 *     continuation prompt, so the model is told to work under the current values.
 *  3. **A revoked image stops the resume** — before the lease is taken, so the run is left exactly as the crash
 *     left it and can be resumed again once the image is replaced. Revocation is a verdict from the admission
 *     policy, never inferred from a diff: a replaced digest and a revoked one look identical field by field.
 *  4. **A check that did not happen is not a clean bill of health.** An unreadable source, a run with no
 *     snapshot, a capture refused for carrying a credential and a deployment with no port at all are each
 *     reported with their own reason — never as "unchanged".
 *  5. **The comparison is restricted to the environment.** The snapshot's descriptive fields (its creation time,
 *     the run-scoped process facts) are not reported as environment changes.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: SESSION,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    userId: "user-1",
    mode: "edit",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

/** The environment the run was admitted under: recorded once, as the runner's snapshot provider does. */
const RECORDED_ENVIRONMENT = {
  featureFlags: { master: true, flags: { "code.background_runs": false } },
  policyComposition: { projectPolicyVersion: 3, approvalRulesRevision: 2, companyMembershipRevision: 5 },
  providerDataPolicy: { version: 3, classification: "internal" },
  sandboxImage: { digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sbomRef: "sbom/a.json" },
};

async function harness(input: {
  /** What the environment looks like NOW. Missing entries fall back to the recorded values. */
  current?: Partial<{
    featureFlags: Record<string, unknown> | null;
    policyComposition: Record<string, unknown> | null;
    providerDataPolicy: { version: number | null; classification: string | null } | null;
    sandboxImage: { recordedDigest: string | null; status: "admitted" | "revoked" | "unknown"; replacement: string | null; reason: string } | null;
  }>;
  /** A family reader that throws, to model a source this deployment cannot answer. */
  throwFor?: "featureFlags" | "policyComposition" | "providerDataPolicy" | "sandboxImage";
  withRecordedSnapshot?: boolean;
  withEnvironmentPort?: boolean;
  /** A source value that carries a credential, which must refuse the snapshot write entirely. */
  credentialInSource?: boolean;
} = {}) {
  const store = new InMemoryWorkspaceStore();
  const clock = { t: T0 };
  const log = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => clock.t });

  await log.startRun({
    ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "worker-a", runId: RUN,
    request: "make the parser test pass",
  });
  await log.appendTurn({ companyId: COMPANY, runId: RUN, turnIndex: 1, status: "finished", outcome: "ok" });
  // The reconciler's own state: the run is `interrupted` and nobody holds a lease, which is the resumable state.
  clock.t = T0 + 2 * 60 * 60_000;
  await log.markInterrupted({ companyId: COMPANY, runId: RUN, reason: "lease_expired" });

  if (input.withRecordedSnapshot !== false) {
    await store.createExecutionSnapshot({
      companyId: COMPANY,
      workspaceId: "ws-1",
      projectId: PROJECT,
      sessionId: SESSION,
      runId: RUN,
      trigger: "run_start",
      createdBy: "user-1",
      now: new Date(T0),
      payload: { snapshotSchemaVersion: 1, trigger: "run_start", createdAt: new Date(T0).toISOString(), actor: "user-1", ...RECORDED_ENVIRONMENT },
    });
  }

  const current = input.current ?? {};
  const sources: ResumeEnvironmentSources = {
    featureFlags: async () => {
      if (input.throwFor === "featureFlags") throw new Error("flag service down");
      if (current.featureFlags !== undefined) return current.featureFlags;
      return input.credentialInSource
        ? { master: true, note: "token sk_live_0123456789abcdefghijkl" }
        : { master: true, flags: { "code.background_runs": false } };
    },
    policyComposition: async () => {
      if (input.throwFor === "policyComposition") throw new Error("policy store down");
      return current.policyComposition !== undefined ? current.policyComposition : RECORDED_ENVIRONMENT.policyComposition;
    },
    providerDataPolicy: async () => {
      if (input.throwFor === "providerDataPolicy") throw new Error("policy service down");
      return current.providerDataPolicy !== undefined ? current.providerDataPolicy : RECORDED_ENVIRONMENT.providerDataPolicy;
    },
    sandboxImage: async () => {
      if (input.throwFor === "sandboxImage") throw new Error("image catalogue down");
      if (current.sandboxImage !== undefined) return current.sandboxImage;
      return {
        recordedDigest: RECORDED_ENVIRONMENT.sandboxImage.digest,
        status: "admitted",
        replacement: null,
        reason: "status_verified",
      };
    },
  };

  const deps: CodeSessionResumeDeps = {
    flags: { assertEnabled: async () => true },
    sessions: {
      get: async (_ctx, companyId, sessionId) => {
        if (companyId !== COMPANY || sessionId !== SESSION) throw new WorkspaceNotFoundError("Code session not found");
        return session({ runId: RUN });
      },
    },
    runState: new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => clock.t }),
    store: {
      getCodeSessionHead: (companyId, sessionId) => store.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (value) => store.setCodeSessionHead(value),
      getLatestCodeRunRecoveryNotice: (companyId, runId) => store.getLatestCodeRunRecoveryNotice(companyId, runId),
      listCodeContextSummaries: (value) => store.listCodeContextSummaries(value),
      listCodeGoals: (value) => store.listCodeGoals(value),
      getLatestCodeSessionPlan: (companyId, sessionId) => store.getLatestCodeSessionPlan(companyId, sessionId),
      listCodeSessionTodos: (value) => store.listCodeSessionTodos(value),
      listCodeRunTurns: (companyId, runId) => store.listCodeRunTurns(companyId, runId),
      getCodeRunRequest: (companyId, runId) => store.getCodeRunRequest(companyId, runId),
    },
    linkRun: async () => ({ linked: true }),
    activity: { record: async () => undefined },
    ...(input.withEnvironmentPort === false
      ? {}
      : {
        environment: createResumeEnvironmentAdmission({
          store,
          sources,
          now: () => new Date(clock.t),
        }),
      }),
    owner: "resume-worker",
    now: () => clock.t,
  };

  return {
    store,
    clock,
    log,
    sources,
    service: new CodeSessionResumeService(deps),
  };
}

describe("security-gate: C10 resume — the environment re-check", () => {
  it("records a new snapshot version with trigger `resume` and reports the store's diff", async () => {
    const h = await harness({
      current: {
        policyComposition: { projectPolicyVersion: 4, approvalRulesRevision: 2, companyMembershipRevision: 5 },
      },
    });
    const outcome = await h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION });

    expect(outcome.status).toBe("resumed");
    // A NEW version, built from the resume-time facts, linked to the one the run was admitted under.
    expect(outcome.environment.captured).toBe(true);
    expect(outcome.environment.previousVersion).toBe(1);
    expect(outcome.environment.snapshotVersion).toBe(2);
    expect(outcome.environment.snapshotId).not.toBe(outcome.environment.previousSnapshotId);

    const stored = await h.store.getSnapshotForRun(COMPANY, RUN);
    expect(stored?.id).toBe(outcome.environment.snapshotId);
    // The trigger is the one that had a vocabulary entry and no producer until now.
    expect(stored?.trigger).toBe("resume");
    expect(stored?.prevSnapshotId).toBe(outcome.environment.previousSnapshotId);
    // The new snapshot records the CURRENT facts, so "what this continuation runs in" is answerable later.
    expect((stored?.payload.policyComposition as Record<string, unknown>).projectPolicyVersion).toBe(4);
    expect(stored?.payload.reason).toBe("resume_environment_check");

    // The diff is the store's own content-safe rendering, restricted to the environment families.
    expect(outcome.environment.changes).toEqual([
      { field: "policyComposition.projectPolicyVersion", from: "3", to: "4" },
    ]);
    expect(outcome.environment.blocking).toBe(false);
    expect(outcome.environment.reason).toBe("environment_changed");
    // The image was confirmed admitted, so it is reported as a verdict and not as a change.
    expect(outcome.environment.image).toMatchObject({ status: "admitted" });
    // Everything reported as a *change* is a diffable environment family: the snapshot's own descriptive fields
    // (its creation time, the trigger, the run-scoped process facts) are not "environment changes".
    for (const change of outcome.environment.changes) {
      expect(RESUME_ENVIRONMENT_DIFF_FAMILIES.some((family) => change.field === family || change.field.startsWith(`${family}.`))).toBe(true);
    }
    // A change is stated to the caller and to the model, never swallowed.
    expect(outcome.resumePromptSections).toContain("environment");
    expect(outcome.resumePrompt).toContain("policyComposition.projectPolicyVersion: 3 -> 4");
    expect(outcome.resumePrompt).toContain("Continue under the CURRENT values above");
  });

  it("says nothing about the environment when nothing moved", async () => {
    const h = await harness();
    const outcome = await h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION });
    expect(outcome.environment.captured).toBe(true);
    expect(outcome.environment.changes).toEqual([]);
    expect(outcome.environment.reason).toBe("environment_unchanged");
    // A clean comparison adds no section: the prompt says what is relevant, not what is unremarkable.
    expect(outcome.resumePromptSections).not.toContain("environment");
  });

  it("stops the resume when the sandbox image was revoked, leaving the run untouched", async () => {
    const h = await harness({
      current: {
        sandboxImage: {
          recordedDigest: RECORDED_ENVIRONMENT.sandboxImage.digest,
          status: "revoked",
          replacement: "npati/sandbox-node-1@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          reason: "image_revoked",
        },
      },
    });
    await expect(h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION }))
      .rejects.toMatchObject({ code: "run_environment_revoked", httpStatus: 409, retryable: true });

    // The refusal happened before the lease was taken: the run is exactly as the crash left it, so resolving
    // the image and resuming again is possible.
    const state = await h.store.getCodeRunState(COMPANY, RUN);
    expect(state?.status).toBe("interrupted");
    // The crashed worker's name may still be on the row; what matters is that nothing moved: no new owner, no
    // `running` status, and the resume did not consume the interruption.
    expect(state?.leaseOwner).toBe("worker-a");
    // The attempt is still evidence: the snapshot recording the revoked environment was written.
    const stored = await h.store.getSnapshotForRun(COMPANY, RUN);
    expect(stored?.trigger).toBe("resume");
    const image = stored?.payload.sandboxImage as Record<string, unknown>;
    expect(image.status).toBe("revoked");
  });

  it("treats revocation as a verdict, not as a diff: an unchanged digest can still be revoked", async () => {
    // This is the case a field-by-field comparison cannot see: the digest is byte-identical to the recorded one
    // and the image is nevertheless no longer allowed to run.
    const payload = { sandboxImage: { recordedDigest: "sha256:aa", status: "revoked", reason: "image_revoked" } };
    expect(readImageVerdict(payload)).toMatchObject({ status: "revoked", reason: "image_revoked" });
    expect(readImageVerdict({ sandboxImage: { status: "unknown", reason: "image_not_in_catalogue" } }))
      .toMatchObject({ status: "unknown" });
    expect(readImageVerdict({ sandboxImage: { status: "admitted" } })).toMatchObject({ status: "admitted" });
    expect(readImageVerdict({})).toBeNull();

    const h = await harness({
      current: {
        sandboxImage: {
          recordedDigest: RECORDED_ENVIRONMENT.sandboxImage.digest,
          status: "revoked", replacement: null, reason: "image_revoked",
        },
      },
    });
    await expect(h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION }))
      .rejects.toMatchObject({ code: "run_environment_revoked" });
  });

  it("reports a family it could not read instead of calling it unchanged", async () => {
    const h = await harness({ throwFor: "providerDataPolicy" });
    const outcome = await h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION });
    expect(outcome.environment.captured).toBe(true);
    expect(outcome.environment.notCompared).toContainEqual({
      family: "providerDataPolicy",
      reason: "resume_environment_source_unavailable",
    });
    // The unreadable family is stated in the prompt too — "we could not compare this" is not silence.
    expect(outcome.resumePromptSections).toContain("environment");
    expect(outcome.resumePrompt).toContain("providerDataPolicy: not compared");
  });

  it("says there is nothing to compare when the run was recorded before snapshots existed", async () => {
    const h = await harness({ withRecordedSnapshot: false });
    const outcome = await h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION });
    // The new snapshot is still recorded — the continuation's environment is evidence in its own right.
    expect(outcome.environment.captured).toBe(true);
    expect(outcome.environment.previousSnapshotId).toBeNull();
    expect(outcome.environment.reason).toBe("no_snapshot_recorded_for_run");
    expect(outcome.environment.notCompared).toHaveLength(RESUME_ENVIRONMENT_FAMILIES.length);
    expect(outcome.environment.changes).toEqual([]);
  });

  it("refuses to record a resume snapshot whose facts carry a credential, and never claims unchanged", async () => {
    const h = await harness({ credentialInSource: true });
    const outcome = await h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION });
    expect(outcome.environment.captured).toBe(false);
    expect(outcome.environment.reason).toBe("resume_snapshot_not_recorded");
    expect(outcome.environment.changes).toEqual([]);
    // Nothing was written: a snapshot carrying the value must not exist at all.
    const stored = await h.store.getSnapshotForRun(COMPANY, RUN);
    expect(stored?.trigger).toBe("run_start");
    expect(JSON.stringify(stored?.payload)).not.toContain("sk_live");
  });

  it("reports a missing admission port as not configured, without adding noise to the prompt", async () => {
    const h = await harness({ withEnvironmentPort: false });
    const outcome = await h.service.resume({ ctx, companyId: COMPANY, sessionId: SESSION });
    expect(outcome.environment.captured).toBe(false);
    expect(outcome.environment.reason).toBe("environment_check_not_configured");
    expect(outcome.environment.notCompared).toEqual([]);
    expect(outcome.resumePromptSections).not.toContain("environment");
  });
});
