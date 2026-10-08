import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import {
  CODE_AGENT_MASTER_FLAG,
  CODE_MODEL_PROFILE_PATTERN,
  FeatureFlagService,
  isValidCodeFlagKey,
} from "../apps/agent-api/src/feature-flags";
import {
  CODE_MODEL_PROFILE_FLAG_PREFIX,
  CONSERVATIVE_CODE_MODEL_PROFILE_ID,
  DEFAULT_CODE_MODEL_PROFILES,
  codeModelProfileFlagKey,
  resolveEnabledModelProfileIds,
  resolveModelProfile,
} from "../apps/agent-api/src/code-model-profiles";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * C14 (model profiles): `code.model_profile.<id>` really decides which profiles a run may match.
 *
 * The defect this suite pins is a **silent no-op**, the same class as C8's unwired `runCtags`: the runner's
 * `ports.modelProfiles` was declared and read, the flag key had been allowlisted since C1a, the registry was
 * built and unit-tested — and the composition never supplied the port, so `enabledProfileIds` never reached
 * `resolveModelProfile`. A deployment could not enable or exclude one profile, while
 * `docs/coding-agent/current-state.md` claimed the ExecutionSnapshot recorded "with which profile the run
 * executed" as if that profile were the deployment's choice.
 *
 * Three independent layers, because each catches a different half:
 *  1. **flag → ids**: a real `FeatureFlagService` over the in-memory store decides the enabled set, per
 *     company, and a disabled flag really removes its profile from resolution (an unknown model then falls
 *     back to the conservative default instead of inheriting the excluded profile);
 *  2. **runner → port**: the runner is driven with a per-run resolver and the profile it *recorded* through
 *     `ensureModelProfilesVersion` is asserted — deleting the port (or the resolver) changes that answer, so
 *     the test is not vacuous. The enabled ids **filter** the registry rather than force a profile, so each
 *     run's model is chosen to match the enabled profile the test expects, and the negative controls record
 *     what the unfiltered registry would have picked for the very same model;
 *  3. **composition → runner**: a source guard on `app.ts`, so the wiring cannot be dropped again while every
 *     pure unit test stays green.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ctx: AuthContext = {
  userId: "user-c14",
  workspaceId: "ws-c14",
  permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
};

function session(): CodeSession {
  return {
    id: "session-c14",
    workspaceId: "ws-c14",
    companyId: "company-c14",
    projectId: "project-c14",
    userId: "user-c14",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------------------------------------
// 1. The flags decide the enabled set
// ---------------------------------------------------------------------------------------------------------

/** A real flag service over the in-memory store, with the master flag on for two companies. */
async function flagHarness() {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const admin: AuthContext = {
    workspaceId: "ws-c14-flags",
    userId: "c14-admin",
    permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
  };
  // No audit service: this suite measures the resolution, not the journal (C1c owns that).
  const flags = new FeatureFlagService(store, undefined, { cacheTtlMs: 1_000 });
  const companyA = await store.createCompany(admin, { name: "C14 flags A" }, "c14-flags-a");
  const companyB = await store.createCompany(admin, { name: "C14 flags B" }, "c14-flags-b");
  // `internal` is the strongest stage a flag may be set at before the G1/R1 gates pass, and it requires an
  // administrative actor — which is exactly the caller the deployment uses for a rollout.
  await flags.setFlag(admin, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true });
  return { store, flags, admin, companyA, companyB };
}

describe("[C14] [security-gate] code.model_profile.<id> flags reach enabledProfileIds", () => {
  it("enables exactly the profiles whose flag is on, per company, and excludes every other one", async () => {
    const h = await flagHarness();
    const masterOn = { flags: h.flags, ctx: h.admin };

    // Only the master flag is on: no profile is enabled. An empty list is the fail-closed answer — a
    // deployment that has not enabled a profile must not get native tool calling and parallel writes.
    expect(await resolveEnabledModelProfileIds({ ...masterOn, companyId: h.companyA.id })).toEqual([]);
    expect(await resolveEnabledModelProfileIds({ ...masterOn, companyId: h.companyB.id })).toEqual([]);

    await h.flags.setFlag(h.admin, {
      scope: "company",
      scopeId: h.companyA.id,
      flagKey: codeModelProfileFlagKey("local-text-tools"),
      stage: "internal",
      enabled: true,
    });

    const enabledForA = await resolveEnabledModelProfileIds({ ...masterOn, companyId: h.companyA.id });
    // Exact list, in registry order: the two profiles that were not enabled are genuinely absent, which is
    // the assertion a "return every registry id" implementation fails.
    expect(enabledForA).toEqual(["local-text-tools"]);
    expect(enabledForA).not.toContain("hosted-native-tools");
    expect(enabledForA).not.toContain("hosted-native-tools-small-context");
    // The flag is company-scoped, so the other company is untouched.
    expect(await resolveEnabledModelProfileIds({ ...masterOn, companyId: h.companyB.id })).toEqual([]);
  });

  it("a disabled flag excludes its profile, so the same model resolves to the conservative default", async () => {
    const h = await flagHarness();
    const key = codeModelProfileFlagKey("local-text-tools");
    const model = "my-local-llama";

    await h.flags.setFlag(h.admin, { scope: "company", scopeId: h.companyA.id, flagKey: key, stage: "internal", enabled: true });
    const enabled = await resolveEnabledModelProfileIds({ flags: h.flags, ctx: h.admin, companyId: h.companyA.id });
    // The registry would match this model on its `*local*` pattern, so the answer below is the registry's.
    expect(resolveModelProfile({ provider: "ollama", model, enabledProfileIds: enabled }).profile.id).toBe("local-text-tools");

    // Turning the flag off (the same row, `off`/disabled) is what a kill switch for one profile looks like.
    await h.flags.setFlag(h.admin, { scope: "company", scopeId: h.companyA.id, flagKey: key, stage: "off", enabled: false });
    const disabled = await resolveEnabledModelProfileIds({ flags: h.flags, ctx: h.admin, companyId: h.companyA.id });
    expect(disabled).toEqual([]);
    const resolved = resolveModelProfile({ provider: "ollama", model, enabledProfileIds: disabled });
    expect(resolved.profile.id).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(resolved.matchedBy).toBe("default");
  });

  it("fails closed without a flag reader and when the flag store throws", async () => {
    const h = await flagHarness();
    const throwing = {
      isEnabled: async () => {
        throw new Error("flag store unavailable");
      },
    };
    expect(await resolveEnabledModelProfileIds({ flags: throwing, ctx: h.admin, companyId: h.companyA.id })).toEqual([]);
    expect(await resolveEnabledModelProfileIds({ flags: null, ctx: h.admin, companyId: h.companyA.id })).toEqual([]);
    expect(await resolveEnabledModelProfileIds({ ctx: h.admin, companyId: h.companyA.id })).toEqual([]);
    // And an empty answer is passed on to the resolver as "nothing is enabled" — never as "no filter", which
    // would silently restore the whole registry.
    expect(resolveModelProfile({ provider: "ollama", model: "my-local-llama", enabledProfileIds: [] }).profile.id)
      .toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(resolveModelProfile({ provider: "ollama", model: "my-local-llama" }).profile.id).toBe("local-text-tools");
  });

  it("builds a flag key the feature-flag allowlist accepts for every registry profile", () => {
    for (const profile of DEFAULT_CODE_MODEL_PROFILES) {
      const flagKey = codeModelProfileFlagKey(profile.id);
      expect(flagKey.startsWith(CODE_MODEL_PROFILE_FLAG_PREFIX)).toBe(true);
      expect(CODE_MODEL_PROFILE_PATTERN.test(flagKey)).toBe(true);
      // The key must be settable at all: `setFlag` refuses anything `CODE_FLAG_KEY_PATTERN` does not match,
      // so a profile whose id cannot be expressed as a flag would be un-gateable rather than merely ungated.
      expect(isValidCodeFlagKey(flagKey)).toBe(true);
    }
    expect(codeModelProfileFlagKey(CONSERVATIVE_CODE_MODEL_PROFILE_ID)).toBe("code.model_profile.conservative-default");
    // One registry, and the conservative default is deliberately not part of it: it is the fail-closed
    // fallback, so no flag can switch it off (that would leave an unknown model with no profile at all).
    expect(DEFAULT_CODE_MODEL_PROFILES).toHaveLength(3);
    expect(DEFAULT_CODE_MODEL_PROFILES.map((profile) => profile.id)).not.toContain(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. The runner reads the port
// ---------------------------------------------------------------------------------------------------------

interface RunOptions {
  model?: string;
  modelProfiles?: CodingAgentRunnerPorts["modelProfiles"];
}

/**
 * Drives one complete run with a one-message transcript and reports the profile the runner **recorded** through
 * the C6b version registry. Every other port is the smallest working stub; nothing here resolves a profile, so
 * the recorded id is the runner's own answer.
 */
async function runOnce(options: RunOptions = {}) {
  const profilesRecorded: string[] = [];
  const calls: Array<{ companyId: string; projectId: string; sessionId?: string }> = [];
  const environment = createCodeRunEnvironmentHolder();
  const configured = options.modelProfiles
    ? {
        ...options.modelProfiles,
        ...(options.modelProfiles.enabledProfileIdsForRun
          ? {
              enabledProfileIdsForRun: async (input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string }) => {
                calls.push({ companyId: input.companyId, projectId: input.projectId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
                return options.modelProfiles!.enabledProfileIdsForRun!(input);
              },
            }
          : {}),
      }
    : undefined;
  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => [],
      invoke: async () => {
        throw new Error("C14: the profile suites script no tool calls");
      },
    },
    engine: { chat: async () => ({ content: "done" }) },
    schemas: [],
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async () => undefined },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    limits: { maxStepsPerRun: 4, maxRunMinutes: 5, parallelReadOnlyCalls: 8 },
    environment,
    snapshot: { create: async () => ({ snapshotId: "snap-c14" }) },
    snapshotConfigVersions: {
      ensureSystemPromptVersion: async () => ({ version: 1, contentHash: "sha256:c14-prompt" }),
      ensureModelProfilesVersion: async ({ profile }) => {
        profilesRecorded.push(profile.id);
        return 1;
      },
    },
    ...(configured ? { modelProfiles: configured } : {}),
  };
  const runner = new CodingAgentRunner(ports);
  const result = await runner.run({ ctx, session: session(), prompt: "fix the failing test", model: options.model ?? "gpt-4o" });
  return { result, profileId: profilesRecorded[0], calls, environment };
}

describe("[C14] [security-gate] the runner really reads ports.modelProfiles", () => {
  it("records the profile the per-run resolver enabled, with the run's own context", async () => {
    // `enabledProfileIds` is a **filter over the registry**, not a forced selection: `resolveModelProfile`
    // considers only the listed profiles and still requires the model to match one of them, falling back to
    // the conservative profile when none matches (`ResolveModelProfileInput.enabledProfileIds`). So the model
    // here must be one the enabled profile really matches, or the run cannot record that id at all.
    //
    // `openai/gpt-4o-mini` matches two registry profiles: `hosted-native-tools-small-context` on its `*mini*`
    // pattern and `hosted-native-tools` on the `openai` provider. The pattern outranks the provider match
    // (`profileMatchSpecificity`), so enabling only `hosted-native-tools` is what moves this run.
    const harnessed = await runOnce({
      model: "openai/gpt-4o-mini",
      modelProfiles: { enabledProfileIdsForRun: async () => ["hosted-native-tools"] },
    });
    expect(harnessed.result.status).toBe("completed");
    expect(harnessed.profileId).toBe("hosted-native-tools");
    // Negative control: the same model against the unfiltered registry records the pattern match, so the id
    // above is the resolver's answer rather than a coincidence of the registry order.
    const unfiltered = await runOnce({ model: "openai/gpt-4o-mini" });
    expect(unfiltered.profileId).toBe("hosted-native-tools-small-context");
    // The enabled set is resolved for **this** run (workspace/company scoped flags cannot be read once at
    // boot), so the resolver must have been called with the run's identity — once, not per step.
    expect(harnessed.calls).toEqual([{ companyId: "company-c14", projectId: "project-c14", sessionId: "session-c14" }]);
  });

  it("falls back to the conservative profile when the port is absent, which is the defect this closes", async () => {
    const bare = await runOnce({});
    expect(bare.result.status).toBe("completed");
    // `gpt-4o` matches no registry pattern and, without the port, no provider either: the pre-C14 production
    // composition always landed here, whatever the operator had configured.
    expect(bare.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
  });

  it("treats an empty answer as 'nothing enabled', a non-matching enabled id as fail-closed, and a throwing resolver as fail-closed", async () => {
    const empty = await runOnce({ modelProfiles: { enabledProfileIdsForRun: async () => [] } });
    expect(empty.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);

    // Enabling a profile is a permission, never a promotion: `gpt-4o` matches no registry profile, so
    // enabling the small-context profile must not hand it to a model that does not match it.
    const nonMatching = await runOnce({
      modelProfiles: { enabledProfileIdsForRun: async () => ["hosted-native-tools-small-context"] },
    });
    expect(nonMatching.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);

    const throwing = await runOnce({
      modelProfiles: {
        enabledProfileIdsForRun: async () => {
          throw new Error("flag store unavailable");
        },
      },
    });
    expect(throwing.result.status).toBe("completed");
    expect(throwing.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
  });

  it("keeps the static enabledProfileIds list working and lets the resolver override it", async () => {
    // One model for all three runs, so the only variable is *which list decides*. `ollama/qwen2.5-mini`
    // matches `local-text-tools` through its `ollama` provider and `hosted-native-tools-small-context`
    // through `*mini*` — and the latter is what the unfiltered registry picks, so every answer below is
    // attributable to a list rather than to the registry.
    const staticOnly = await runOnce({ model: "ollama/qwen2.5-mini", modelProfiles: { enabledProfileIds: ["local-text-tools"] } });
    expect(staticOnly.profileId).toBe("local-text-tools");

    // `null` from the resolver means "keep the static list", not "no filter": an unfiltered answer here
    // would be `hosted-native-tools-small-context`.
    const kept = await runOnce({
      model: "ollama/qwen2.5-mini",
      modelProfiles: { enabledProfileIds: ["local-text-tools"], enabledProfileIdsForRun: async () => null },
    });
    expect(kept.profileId).toBe("local-text-tools");

    // A non-null answer replaces the static list outright: the statically enabled `local-text-tools` is no
    // longer eligible even though it matches this model, and the run moves to the profile the resolver
    // enabled — which is only possible because the resolver's list really reached `resolveModelProfile`.
    const replaced = await runOnce({
      model: "ollama/qwen2.5-mini",
      modelProfiles: { enabledProfileIds: ["local-text-tools"], enabledProfileIdsForRun: async () => ["hosted-native-tools-small-context"] },
    });
    expect(replaced.profileId).toBe("hosted-native-tools-small-context");
  });

  it("passes the provider of the model id into the profile match", async () => {
    // `hosted-native-tools` matches on its provider list alone, so this run is only explainable if the runner
    // passed the provider: the pre-C14 call site passed `model` and nothing else.
    const byProvider = await runOnce({ model: "anthropic/some-unreleased-model" });
    expect(byProvider.profileId).toBe("hosted-native-tools");
    // The same value is what the ExecutionSnapshot records as the provider, so profile and snapshot agree.
    expect(byProvider.environment.modelSelection()).toEqual({ provider: "anthropic", model: "anthropic/some-unreleased-model" });
    // Negative control: the model-only resolution the old call site performed is the conservative default.
    expect(resolveModelProfile({ model: "anthropic/some-unreleased-model" }).profile.id).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. The composition wires it (source guards)
// ---------------------------------------------------------------------------------------------------------

describe("[C14] [security-gate] the model-profile port is wired in the composition", () => {
  const appSource = readFileSync(path.join(workspaceRoot, "apps", "agent-api", "src", "app.ts"), "utf8");
  const start = appSource.indexOf("new CodingAgentRunner({");
  const end = appSource.indexOf("\n  });", start);
  const runnerBlock = start >= 0 && end > start ? appSource.slice(start, end) : "";

  it("passes the existing registry and the per-run flag resolution into the runner", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(runnerBlock).toContain("modelProfiles:");
    expect(runnerBlock).toContain("profiles: DEFAULT_CODE_MODEL_PROFILES");
    expect(runnerBlock).toContain("enabledProfileIdsForRun");
    expect(runnerBlock).toContain("resolveEnabledModelProfileIds");
    expect(runnerBlock).toContain("flags: featureFlagService");
    // One registry: a second, hand-written profile table here would need these fields.
    expect(runnerBlock).not.toContain("toolCallingMode");
    expect(runnerBlock).not.toContain("contextWindow");
  });

  it("records the provider next to the model, and derives it once for both uses", () => {
    const runnerSource = readFileSync(path.join(workspaceRoot, "apps", "agent-api", "src", "coding-agent-runner.ts"), "utf8");
    expect(runnerSource).toContain("provider: modelProviderHint,");
    // The same hint feeds the snapshot's `modelSelection.provider`; a second computation would be a second
    // answer to "which provider is this run about".
    expect(runnerSource.match(/const modelProviderHint/g)).toHaveLength(1);
  });

  it("keeps the current-state note honest about what the snapshot records", () => {
    const doc = readFileSync(path.join(workspaceRoot, "docs", "coding-agent", "current-state.md"), "utf8");
    // The claim may not go back to asserting the recorded profile is the deployment's without the wiring.
    expect(doc).toContain("C14 correction");
    expect(doc).toContain("code.model_profile.");
    expect(doc).toContain("the composition never supplied it");
  });
});
