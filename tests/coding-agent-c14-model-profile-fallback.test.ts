import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import {
  CONSERVATIVE_CODE_MODEL_PROFILE_ID,
  CODE_MODEL_PROFILE_FALLBACK_REASONS,
  modelProfileFallbackReasonFor,
  modelProfileFallbackTrace,
  modelProfileTrace,
  resolveModelProfile,
} from "../apps/agent-api/src/code-model-profiles";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodeRunActivityEvent,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";
import {
  collectExecutionSnapshotPayload,
  EXECUTION_SNAPSHOT_SCHEMA_VERSION,
  type ExecutionSnapshotSources,
} from "../apps/agent-api/src/execution-snapshot";
import {
  assertMetadataOnlyActivityPayload,
  assertNoSecretsInActivityPayload,
} from "../apps/agent-api/src/code-run-activity-sink";

/**
 * C14 (owner decision 2): the conservative model profile stays the fail-closed answer, and the **degradation
 * becomes visible**.
 *
 * The decision deliberately does *not* replace `enabledProfileIds == []` with automatic pattern matching — that
 * would hand every deployment the behaviour the `code.model_profile.<id>` flags exist to gate. What it requires
 * instead is that the fallback stop being silent: a run that could have had a configured profile and got the
 * conservative one must *say so*, with a reason that distinguishes the two situations that need different fixes
 * (`profile_flag_disabled` = nothing is rolled out yet, `no_matching_profile` = this model has no profile).
 *
 * Three layers are asserted, because any one of them alone can be satisfied by a no-op:
 *  1. **the mapping** — pure, both values and the `null` (no degradation) case, each with its own control;
 *  2. **the run** — a real `CodingAgentRunner` run publishes the reason through the environment holder **and**
 *     every Activity event written after the profile was resolved carries it, while a run that matched a profile
 *     carries nothing (removing the field from the runner fails these assertions);
 *  3. **the records** — the reason reaches the ExecutionSnapshot payload (additively: the key is absent when the
 *     deployment does not wire the source, so no already-persisted snapshot is reinterpreted) and the composition
 *     wires both the snapshot source and the Inspector section (source guards, the same pattern the sibling C14
 *     suite uses for the runner port).
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ctx: AuthContext = {
  userId: "user-c14-fallback",
  workspaceId: "ws-c14-fallback",
  permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
};

function session(): CodeSession {
  return {
    id: "session-c14-fallback",
    workspaceId: "ws-c14-fallback",
    companyId: "company-c14-fallback",
    projectId: "project-c14-fallback",
    userId: "user-c14-fallback",
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
// 1. The mapping
// ---------------------------------------------------------------------------------------------------------

describe("[C14] [security-gate] the profile fallback reason is a closed, two-valued vocabulary", () => {
  it("separates an empty rollout from a model that matches nothing, and says nothing when a profile matched", () => {
    // The registry would match `my-local-llama` on its `*local*` pattern — so the *only* reason this resolution
    // lands on the conservative profile is the empty enabled list.
    const model = "my-local-llama";
    const provider = "ollama";
    const unfiltered = resolveModelProfile({ provider, model });
    expect(unfiltered.profile.id).toBe("local-text-tools");
    expect(modelProfileFallbackReasonFor(unfiltered, undefined)).toBe(null);

    const nothingEnabled = resolveModelProfile({ provider, model, enabledProfileIds: [] });
    expect(nothingEnabled.profile.id).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(nothingEnabled.matchedBy).toBe("default");
    expect(modelProfileFallbackReasonFor(nothingEnabled, [])).toBe("profile_flag_disabled");

    // The same fallback with a *non-empty* list is the other situation: profiles are rolled out, this model just
    // is not one of them. Same profile, different reason — which is exactly why one value was not enough.
    const noMatch = resolveModelProfile({ provider, model, enabledProfileIds: ["hosted-native-tools"] });
    expect(noMatch.profile.id).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(modelProfileFallbackReasonFor(noMatch, ["hosted-native-tools"])).toBe("no_matching_profile");

    // No filter at all means the whole registry was searched: a miss there is a genuine no-match, not a rollout
    // that has not been switched on. Both `undefined` and `null` read that way.
    expect(modelProfileFallbackReasonFor(resolveModelProfile({ model: "totally-unknown-model" }), undefined)).toBe("no_matching_profile");
    expect(modelProfileFallbackReasonFor(resolveModelProfile({ model: "totally-unknown-model" }), null)).toBe("no_matching_profile");

    // The vocabulary is closed and public: a UI or a validator reads the same two values the resolver produces.
    expect([...CODE_MODEL_PROFILE_FALLBACK_REASONS]).toEqual(["profile_flag_disabled", "no_matching_profile"]);
    expect(new Set(CODE_MODEL_PROFILE_FALLBACK_REASONS).size).toBe(2);
  });

  it("keeps the C6 trace contract intact and adds the reason beside it", () => {
    const resolved = resolveModelProfile({ provider: "anthropic", model: "claude-3-5-sonnet" });
    // The four keys of `modelProfileTrace` are a pinned C6 contract ("exposes a stable trace for Activity");
    // C14 must not have changed them, which is why the reason lives in a separate, additive function.
    expect(Object.keys(modelProfileTrace(resolved)).sort()).toEqual(["matchedBy", "maxParallelToolCalls", "profileId", "toolCallingMode"]);

    const matched = modelProfileFallbackTrace(resolved, { enabledProfileIds: ["hosted-native-tools"] });
    expect(Object.keys(matched).sort()).toEqual(["enabledProfileIds", "fallbackReason", "matchedBy", "maxParallelToolCalls", "profileId", "toolCallingMode"]);
    expect(matched.fallbackReason).toBe(null);
    expect(matched.enabledProfileIds).toEqual(["hosted-native-tools"]);
    // The additive trace still *is* the C6 trace: every pinned field is carried over unchanged.
    expect(matched).toMatchObject(modelProfileTrace(resolved));

    const fellBack = modelProfileFallbackTrace(resolveModelProfile({ model: "totally-unknown-model" }), { enabledProfileIds: [] });
    expect(fellBack.fallbackReason).toBe("profile_flag_disabled");
    // "No filter supplied" is recorded as `null`, not as an empty list: the two mean different things.
    expect(modelProfileFallbackTrace(resolveModelProfile({ model: "totally-unknown-model" })).enabledProfileIds).toBe(null);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. The run: the environment holder and the Activity events
// ---------------------------------------------------------------------------------------------------------

interface RunCapture {
  profileId: string;
  trace: ReturnType<ReturnType<typeof createCodeRunEnvironmentHolder>["modelProfileTrace"]>;
  events: CodeRunActivityEvent[];
  status: string;
}

async function runOnce(model: string, enabledProfileIdsForRun: () => Promise<readonly string[]>): Promise<RunCapture> {
  const environment = createCodeRunEnvironmentHolder();
  const events: CodeRunActivityEvent[] = [];
  const profilesRecorded: string[] = [];
  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => [],
      invoke: async () => {
        throw new Error("C14: the fallback suites script no tool calls");
      },
    },
    engine: { chat: async () => ({ content: "done" }) },
    schemas: [],
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    // The real activity port: it receives exactly what the runner records, in order.
    activity: {
      async record(event) {
        events.push(event);
      },
    },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    limits: { maxStepsPerRun: 4, maxRunMinutes: 5, parallelReadOnlyCalls: 8 },
    environment,
    snapshot: { create: async () => ({ snapshotId: "snap-c14-fallback" }) },
    snapshotConfigVersions: {
      ensureSystemPromptVersion: async () => ({ version: 1, contentHash: "sha256:c14-fallback" }),
      ensureModelProfilesVersion: async ({ profile }) => {
        profilesRecorded.push(profile.id);
        return 1;
      },
    },
    modelProfiles: { enabledProfileIdsForRun: async () => enabledProfileIdsForRun() },
  };
  const result = await new CodingAgentRunner(ports).run({ ctx, session: session(), prompt: "fix the failing test", model });
  return { profileId: profilesRecorded[0] ?? "", trace: environment.modelProfileTrace(), events, status: result.status };
}

describe("[C14] [security-gate] the degradation is visible in the run, not only in the resolver", () => {
  it("publishes `profile_flag_disabled` for an empty rollout and carries it on every Activity event after the profile", async () => {
    const run = await runOnce("openai/gpt-4o-mini", async () => []);
    expect(run.status).toBe("completed");
    // The model `openai/gpt-4o-mini` *would* have matched `hosted-native-tools-small-context`, so the conservative
    // profile here is the fail-closed answer and nothing else — the reason is what makes that legible.
    expect(run.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(run.trace?.fallbackReason).toBe("profile_flag_disabled");
    expect(run.trace?.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(run.trace?.enabledProfileIds).toEqual([]);

    const withReason = run.events.filter((event) => event.modelProfileFallbackReason === "profile_flag_disabled");
    expect(withReason.length).toBeGreaterThan(0);
    // At least one of them is a model turn, so the reason is attached to what the run actually did.
    expect(withReason.map((event) => event.kind)).toContain("turn");
    // The events written *before* the profile existed carry nothing: at that moment there was no decision to
    // describe, and a fabricated reason would be a claim about a decision nobody had made.
    const started = run.events.filter((event) => event.kind === "run_started");
    expect(started.length).toBe(1);
    expect(started[0]?.modelProfileFallbackReason).toBe(undefined);

    // The extra key is metadata-only and free of secrets, by the *real* guards the sink uses — a payload that only
    // looks harmless is not the same as one that passes the check the write path applies.
    for (const event of withReason) {
      expect(() => assertMetadataOnlyActivityPayload(event as unknown as Record<string, unknown>)).not.toThrow();
      expect(() => assertNoSecretsInActivityPayload(event)).not.toThrow();
    }
    // Negative control for those two guards: the same shape with a content key and with a credential is refused,
    // so "it passed" above is a statement about this payload rather than about a guard that never fires.
    expect(() => assertMetadataOnlyActivityPayload({ ...withReason[0], command: "rm -rf /" })).toThrow();
    // The 36-character sample the repository's own secret-scanner suite uses, so "it passed" cannot be explained
    // by a credential shape the scanner happens not to know.
    expect(() => assertNoSecretsInActivityPayload({ ...withReason[0], note: "ghp_0123456789abcdefghijklmnopqrstuvwxyz" })).toThrow();
  });

  it("publishes `no_matching_profile` when profiles are enabled but none matches, and nothing when one does", async () => {
    const noMatch = await runOnce("openai/gpt-4o-mini", async () => ["local-text-tools"]);
    expect(noMatch.profileId).toBe(CONSERVATIVE_CODE_MODEL_PROFILE_ID);
    expect(noMatch.trace?.fallbackReason).toBe("no_matching_profile");
    expect(noMatch.trace?.enabledProfileIds).toEqual(["local-text-tools"]);
    expect(noMatch.events.some((event) => event.modelProfileFallbackReason === "no_matching_profile")).toBe(true);

    // The control: the very same model with the profile that matches it. Same code path, no degradation — so the
    // two reasons above are the resolver's answer rather than a field the runner always fills in.
    const matched = await runOnce("openai/gpt-4o-mini", async () => ["hosted-native-tools-small-context"]);
    expect(matched.profileId).toBe("hosted-native-tools-small-context");
    expect(matched.trace?.fallbackReason).toBe(null);
    expect(matched.events.length).toBeGreaterThan(0);
    expect(matched.events.every((event) => event.modelProfileFallbackReason === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. The records: the ExecutionSnapshot payload and the composition
// ---------------------------------------------------------------------------------------------------------

/** The sources `app.ts` wires, with the optional C14 one under the caller's control. */
function snapshotSources(fallbackReason: (() => Promise<string | null>) | null): ExecutionSnapshotSources {
  return {
    toolManifestVersion: async () => 9,
    policyVersion: async () => null,
    modelProfileVersion: async () => 1,
    modelSelection: async () => ({ provider: "openai", model: "openai/gpt-4o-mini" }),
    systemPrompt: async () => ({ version: 1, contentHash: "sha256:c14-fallback" }),
    runnerVersion: async () => "test",
    sandboxImage: async () => null,
    featureFlags: async () => null,
    providerDataPolicy: async () => null,
    baseCommit: async () => null,
    projectInstructions: async () => null,
    toolchain: async () => null,
    ...(fallbackReason ? { modelProfileFallbackReason: fallbackReason } : {}),
  };
}

describe("[C14] [security-gate] the reason reaches the ExecutionSnapshot payload additively", () => {
  it("records the reason when the source is wired, and leaves the payload's key set alone when it is not", async () => {
    const run = await runOnce("openai/gpt-4o-mini", async () => []);
    const environment = createCodeRunEnvironmentHolder();
    environment.setModelProfileTrace(run.trace);

    // Exactly the expression `app.ts` uses as the snapshot source.
    const source = async () => environment.modelProfileTrace()?.fallbackReason ?? null;
    const withSource = await collectExecutionSnapshotPayload({
      sources: snapshotSources(source),
      actor: "user-c14-fallback",
      role: "owner",
      now: new Date("2026-10-07T00:00:00.000Z"),
      trigger: "run_start",
    });
    expect(withSource.payload.modelProfileFallbackReason).toBe("profile_flag_disabled");
    expect(withSource.payload.modelProfileVersion).toBe(1);
    // The payload stays the version it was: the key is additive, so an already-persisted snapshot is still read as
    // exactly what it was (rule 13) and no reader has to learn a new schema.
    expect(withSource.payload.snapshotSchemaVersion).toBe(EXECUTION_SNAPSHOT_SCHEMA_VERSION);

    // A deployment that does not wire the source must not get the key at all — otherwise every pre-C14 snapshot
    // would suddenly look like it was missing a field rather than like it never had one.
    const withoutSource = await collectExecutionSnapshotPayload({
      sources: snapshotSources(null),
      actor: "user-c14-fallback",
      role: "owner",
      now: new Date("2026-10-07T00:00:00.000Z"),
      trigger: "run_start",
    });
    expect(Object.keys(withoutSource.payload)).not.toContain("modelProfileFallbackReason");

    // A run that matched a profile records `null` (a real answer: no degradation) rather than a reason.
    const matched = await runOnce("openai/gpt-4o-mini", async () => ["hosted-native-tools-small-context"]);
    const matchedEnvironment = createCodeRunEnvironmentHolder();
    matchedEnvironment.setModelProfileTrace(matched.trace);
    const matchedPayload = await collectExecutionSnapshotPayload({
      sources: snapshotSources(async () => matchedEnvironment.modelProfileTrace()?.fallbackReason ?? null),
      actor: "user-c14-fallback",
      role: "owner",
      now: new Date("2026-10-07T00:00:00.000Z"),
      trigger: "run_start",
    });
    expect(matchedPayload.payload.modelProfileFallbackReason).toBe(null);
  });

  it("wires the same source in the composition, and the Inspector section beside it", () => {
    const appSource = readFileSync(path.join(workspaceRoot, "apps", "agent-api", "src", "app.ts"), "utf8");
    // The snapshot source of a real deployment, spelled the same way the test above spells it.
    expect(appSource).toContain("modelProfileFallbackReason: async () => codeRunEnvironment.modelProfileTrace()?.fallbackReason ?? null");
    // The Inspector section (owner decision 2): which ids are allowed, whether the list is empty, and the reason
    // a run would record for an empty one.
    expect(appSource).toContain("enabledProfileIdsIsEmpty");
    expect(appSource).toContain('fallbackReason: empty ? "profile_flag_disabled" : null');
    expect(appSource).toContain("resolveEnabledModelProfileIds({");
    // Additive: the section is spread onto the existing report, in both return paths (plain and combined view).
    expect(appSource).toContain("return { ...report, modelProfiles };");
    expect(appSource).toMatch(/modelProfiles,\s*runtime: \{/);
    // Still no automatic pattern matching for an empty list: the fail-closed behaviour is untouched.
    expect(appSource).not.toContain("enabledProfileIdsIsEmpty ? DEFAULT_CODE_MODEL_PROFILES");
  });

  it("shows the warning in the Inspector UI, through the i18n catalogue of every locale", () => {
    const page = readFileSync(path.join(workspaceRoot, "apps", "web", "src", "CapabilityInspectorPage.tsx"), "utf8");
    // The banner is keyed on the deployment's own state, so it disappears exactly when the rollout starts.
    expect(page).toContain("report?.modelProfiles?.enabledProfileIdsIsEmpty");
    expect(page).toContain('t("capabilityInspector.modelProfiles.emptyHint"');
    expect(page).toContain("registryProfileIds.length");

    // One typed catalogue, seven dictionaries: a key that exists in only one of them would be a silent English
    // leak (the runtime falls back per key), so every locale is checked as data.
    const schema = readFileSync(path.join(workspaceRoot, "apps", "web", "src", "i18n", "types.ts"), "utf8");
    expect(schema).toContain("modelProfiles: {");
    for (const locale of ["en", "uk", "de", "fr", "es", "it", "pl"]) {
      const dictionary = readFileSync(path.join(workspaceRoot, "apps", "web", "src", "i18n", "locales", `${locale}.ts`), "utf8");
      expect(`${locale}:${dictionary.includes("modelProfiles: {")}`).toBe(`${locale}:true`);
      expect(`${locale}:${dictionary.includes("emptyHint:")}`).toBe(`${locale}:true`);
      // The hint is a template with the registry count, not a sentence that hard-codes a number nobody maintains.
      expect(`${locale}:${dictionary.includes("{{count}}")}`).toBe(`${locale}:true`);
    }
  });
});
