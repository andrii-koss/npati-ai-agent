/**
 * C6: the `ExecutionSnapshotProvider` seam.
 *
 * Every run must have an ExecutionSnapshot (rule 19) and every Activity event must reference it (C6b).
 * C6 does **not** implement the snapshot itself: it declares the interface, uses a `NullSnapshotProvider`
 * (which yields the empty id, i.e. "no snapshot available yet") and threads the id through the events it
 * writes. C6b replaces the provider with the real implementation and nothing else has to change.
 *
 * The id is optional everywhere it is used, which keeps every already-persisted event shape valid.
 */

export interface ExecutionSnapshotRef {
  snapshotId: string;
}

export interface ExecutionSnapshotCreateInput {
  companyId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  /** The actor that started the run (a user, never the agent). */
  actor: string;
  agentId?: string;
  /**
   * C6b: the session's workspace, so a run in another workspace is filed under the right tenant. When the
   * caller omits it the provider falls back to the workspace it was constructed with.
   */
  workspaceId?: string;
}

export interface ExecutionSnapshotProvider {
  create(input: ExecutionSnapshotCreateInput): Promise<ExecutionSnapshotRef>;
}

/** The C6 placeholder: an honest empty id rather than a fabricated one. */
export const EMPTY_SNAPSHOT_ID = "";

export class NullSnapshotProvider implements ExecutionSnapshotProvider {
  async create(): Promise<ExecutionSnapshotRef> {
    return { snapshotId: EMPTY_SNAPSHOT_ID };
  }
}

/**
 * Never returns `undefined`: a missing provider means "no snapshot support in this deployment", which is
 * exactly what the null provider expresses. A run therefore cannot fail because C6b is not wired yet.
 */
export function resolveExecutionSnapshotProvider(
  provider?: ExecutionSnapshotProvider | null,
): ExecutionSnapshotProvider {
  return provider ?? new NullSnapshotProvider();
}

/** True when a snapshot id is usable (non-empty). Callers may attach `snapshotId` only when this holds. */
export function hasSnapshotId(snapshotId: string | undefined | null): snapshotId is string {
  return typeof snapshotId === "string" && snapshotId.length > 0;
}

// --- C6b: the real provider -------------------------------------------------------------------------

import { scanTextForSecrets } from "./code-secret-scanner";
import type { AuthContext } from "@npati/workspace";

/** Bumped when the payload shape changes, so an old snapshot is still readable *as what it was*. */
export const EXECUTION_SNAPSHOT_SCHEMA_VERSION = 1;

/** Raised instead of persisting a snapshot whose sources leaked a credential. */
export class SnapshotSecretDetectedError extends Error {
  readonly code = "snapshot_secret_detected";
  readonly httpStatus = 403;
  readonly details: { kinds: string[] };
  constructor(kinds: string[]) {
    super("Execution snapshot refused: a secret-shaped value was found in its sources");
    this.name = "SnapshotSecretDetectedError";
    this.details = { kinds };
  }
}

/**
 * Every value a snapshot is built from, as narrow functions so the provider never reaches into modules
 * directly and a test can supply exact facts. `null` means "this deployment cannot tell" and is recorded as
 * such — never silently omitted, because a missing field reads like "nothing was configured".
 */
export interface ExecutionSnapshotSources {
  toolManifestVersion(): Promise<string | number | null>;
  policyVersion(): Promise<string | number | null>;
  modelProfileVersion(): Promise<string | number | null>;
  modelSelection(): Promise<{ provider: string; model: string; parameters?: Record<string, unknown> } | null>;
  systemPrompt(): Promise<{ version: number | null; contentHash: string | null } | null>;
  runnerVersion(): Promise<string | null>;
  sandboxImage(): Promise<{ digest: string | null; sbomRef?: string | null } | null>;
  featureFlags(): Promise<Record<string, unknown> | null>;
  providerDataPolicy(): Promise<{ version: number | null; classification: string | null } | null>;
  baseCommit(): Promise<{ branch: string | null; commit: string | null; dirty: boolean } | null>;
  projectInstructions(): Promise<{ contentHash: string | null; trustStatus: string } | null>;
  toolchain(): Promise<Record<string, unknown> | null>;
  /**
   * C6b: **no single policy version exists**, so the composition is recorded as its parts (project policy
   * version, approval-rule revision, role/RBAC revision, and hashes of the mode × risk and session-mode
   * matrices, which are code) — a diff then shows *which* part changed instead of only that something did.
   * Optional: a deployment that cannot read them records nothing rather than guessing a number.
   */
  policyComposition?(): Promise<Record<string, unknown> | null>;
  /**
   * C13 (owner decision 6): the **runtime provider capability manifest** in force at admission — for MCP, the
   * provider id, the revision, the manifest hash and, per tool, its id, schema hash, risk, approval requirement
   * and risk source. Metadata only: no schema body, no tool argument, no endpoint.
   *
   * Why it must be in the snapshot at all: the static tool manifest is versioned and immutable, but a runtime
   * MCP tool set is dynamic — a server can add a tool, remove one, or change one tool's input schema between two
   * runs of the same session. Without this field the snapshot would describe a run as "tools: v9" while the run
   * really called a tool that did not exist in v9, and a replay would have nothing to compare against.
   *
   * Optional on purpose (rule 13): a deployment with no runtime provider, or a run that used none, records
   * nothing here and keeps the payload's previous key set — so `EXECUTION_SNAPSHOT_SCHEMA_VERSION` stays at 1
   * and every already-persisted snapshot remains readable as exactly what it was.
   */
  runtimeProviderCapabilities?(input: { workspaceId: string; companyId: string; projectId: string; sessionId?: string }): Promise<Record<string, unknown> | null>;
  /**
   * C14: **why** the run's model was driven with the conservative profile, or `null` when it matched a profile.
   *
   * `modelProfileVersion` above records *which* immutable registry the run resolved against; it cannot say that
   * the run silently lost native tool calling and parallel writes. The two readings of that degradation need
   * different operator action — no profile is enabled at all (`profile_flag_disabled`) versus none of the
   * enabled profiles matches this model (`no_matching_profile`) — so both are recorded here as the closed
   * vocabulary of `CodeModelProfileFallbackReason`, never as free text.
   *
   * Optional on purpose (rule 13): a deployment that does not supply it keeps the payload's previous key set, so
   * every already-persisted snapshot stays readable as exactly what it was and `EXECUTION_SNAPSHOT_SCHEMA_VERSION`
   * does not move.
   */
  modelProfileFallbackReason?(): Promise<string | null>;
}

export interface ExecutionSnapshotPayload extends Record<string, unknown> {
  snapshotSchemaVersion: number;
}

async function readSource<T>(
  name: string,
  read: () => Promise<T | null>,
  unavailable: string[],
): Promise<T | { unavailable: string } | null> {
  try {
    return await read();
  } catch (error) {
    // A snapshot is diagnostic: an unreadable source must be visible as unreadable, not as absent, and must
    // not abort the run that is being explained (the run itself already handles its own failures).
    unavailable.push(name);
    return { unavailable: error instanceof Error ? error.message : "source_failed" };
  }
}

/**
 * Assemble the payload from the sources. Fields that could not be read are recorded with an explicit
 * `{ unavailable }` marker and listed in `unavailable`, so "we could not tell" is distinguishable from
 * "it was empty" when someone reads the snapshot later.
 */
export async function collectExecutionSnapshotPayload(input: {
  sources: ExecutionSnapshotSources;
  actor: string;
  role: string | null;
  agentId?: string;
  now: Date;
  trigger: string;
  /**
   * C13: the tenant the run belongs to, so a source that must answer per-tenant (the runtime provider
   * capability manifest) can be asked. Optional: a caller that supplies none gets the pre-C13 behaviour, and a
   * source that ignores the argument is unaffected.
   */
  tenant?: { workspaceId: string; companyId: string; projectId: string; sessionId?: string };
}): Promise<{ payload: ExecutionSnapshotPayload; unavailable: string[] }> {
  const unavailable: string[] = [];
  const s = input.sources;
  const readPolicyComposition = s.policyComposition;
  const readRuntimeProviderCapabilities = s.runtimeProviderCapabilities;
  const readModelProfileFallbackReason = s.modelProfileFallbackReason;
  const payload: ExecutionSnapshotPayload = {
    snapshotSchemaVersion: EXECUTION_SNAPSHOT_SCHEMA_VERSION,
    trigger: input.trigger,
    createdAt: input.now.toISOString(),
    actor: input.actor,
    actorRole: input.role,
    agentId: input.agentId ?? null,
    toolManifestVersion: await readSource("toolManifestVersion", () => s.toolManifestVersion(), unavailable),
    policyVersion: await readSource("policyVersion", () => s.policyVersion(), unavailable),
    modelProfileVersion: await readSource("modelProfileVersion", () => s.modelProfileVersion(), unavailable),
    modelSelection: await readSource("modelSelection", () => s.modelSelection(), unavailable),
    systemPrompt: await readSource("systemPrompt", () => s.systemPrompt(), unavailable),
    runnerVersion: await readSource("runnerVersion", () => s.runnerVersion(), unavailable),
    sandboxImage: await readSource("sandboxImage", () => s.sandboxImage(), unavailable),
    featureFlags: await readSource("featureFlags", () => s.featureFlags(), unavailable),
    providerDataPolicy: await readSource("providerDataPolicy", () => s.providerDataPolicy(), unavailable),
    baseCommit: await readSource("baseCommit", () => s.baseCommit(), unavailable),
    projectInstructions: await readSource("projectInstructions", () => s.projectInstructions(), unavailable),
    toolchain: await readSource("toolchain", () => s.toolchain(), unavailable),
    // Recorded only when the deployment supplies it, so the payload keeps its previous key set otherwise.
    ...(readPolicyComposition
      ? { policyComposition: await readSource("policyComposition", () => readPolicyComposition(), unavailable) }
      : {}),
    // C13 (owner decision 6): the runtime provider capability manifest, recorded only when the deployment
    // supplies it — so a payload written before the feature existed keeps its exact key set.
    ...(readRuntimeProviderCapabilities
      ? {
          runtimeProviderCapabilities: await readSource(
            "runtimeProviderCapabilities",
            () => readRuntimeProviderCapabilities(input.tenant ?? { workspaceId: "", companyId: "", projectId: "" }),
            unavailable,
          ),
        }
      : {}),
    // C14: why the conservative profile was used, recorded only when the deployment supplies the source. The key
    // is absent for a run that matched a profile *and* for a deployment that does not wire the source, which is
    // why the snapshot schema version stays where it is (rule 13).
    ...(readModelProfileFallbackReason
      ? { modelProfileFallbackReason: await readSource("modelProfileFallbackReason", () => readModelProfileFallbackReason(), unavailable) }
      : {}),
  };
  return { payload, unavailable };
}

/**
 * Refuse to persist a payload that contains a credential. This scans the **serialised** payload rather than
 * trusting the field list: a secret can arrive through any source (an env-derived toolchain entry, a commit
 * message, a prompt line), and "we did not put a secret in" is not a guarantee.
 */
export function assertNoSecretsInSnapshot(payload: Record<string, unknown>): void {
  const scan = scanTextForSecrets(JSON.stringify(payload));
  if (!scan.findings.length) return;
  const kinds = Array.from(new Set(scan.findings.map((finding) => String(finding.kind))));
  throw new SnapshotSecretDetectedError(kinds);
}

/**
 * What a **reader** needs: one lookup by run. Kept separate from the write port so a read-only surface
 * (Run Trace) does not have to claim it can create snapshots — a reader that must implement a writer is a
 * contract that invites a stub.
 */
export interface ExecutionSnapshotReadPort {
  getSnapshotForRun(companyId: string, runId: string): Promise<{ id: string; payload: Record<string, unknown> } | null>;
}

export interface ExecutionSnapshotPersistPort extends ExecutionSnapshotReadPort {
  createExecutionSnapshot(input: {
    companyId: string;
    workspaceId: string;
    projectId: string;
    sessionId: string;
    runId?: string | null;
    payload: Record<string, unknown>;
    trigger: "session_start" | "run_start" | "config_change" | "resume" | "recovery";
    createdBy: string;
    now?: Date;
    id?: string;
  }): Promise<{ id: string }>;
}
export interface RealSnapshotProviderInput {
  store: ExecutionSnapshotPersistPort;
  sources: ExecutionSnapshotSources;
  workspaceId: string;
  /** Resolved at creation time; a missing role is recorded as null rather than guessed. */
  resolveRole?: (input: ExecutionSnapshotCreateInput) => Promise<string | null>;
  now?: () => Date;
  id?: () => string;
}

/**
 * The C6b provider: creates one snapshot per session start and per run start from the sources above.
 * If snapshot creation fails the run is **not** aborted — the caller keeps the empty id, because a diagnostic
 * record must not become a new single point of failure (C6's optional-id contract still holds).
 */
export function createExecutionSnapshotProvider(input: RealSnapshotProviderInput): ExecutionSnapshotProvider {
  return {
    async create(request: ExecutionSnapshotCreateInput): Promise<ExecutionSnapshotRef> {
      const now = input.now?.() ?? new Date();
      const role = input.resolveRole ? await input.resolveRole(request) : null;
      const { payload } = await collectExecutionSnapshotPayload({
        sources: input.sources,
        actor: request.actor,
        role,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        now,
        trigger: request.runId ? "run_start" : "session_start",
        tenant: {
          workspaceId: request.workspaceId ?? input.workspaceId,
          companyId: request.companyId,
          projectId: request.projectId,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        },
      });
      assertNoSecretsInSnapshot(payload);
      const record = await input.store.createExecutionSnapshot({
        companyId: request.companyId,
        workspaceId: request.workspaceId ?? input.workspaceId,
        projectId: request.projectId,
        sessionId: request.sessionId ?? "",
        runId: request.runId ?? null,
        payload,
        trigger: request.runId ? "run_start" : "session_start",
        createdBy: request.actor,
        now,
        ...(input.id ? { id: input.id() } : {}),
      });
      return { snapshotId: record.id };
    },
  };
}

export type SnapshotReadResult =
  | { kind: "snapshot"; snapshotId: string; payload: Record<string, unknown> }
  | { kind: "legacy_no_snapshot"; runId: string };

/**
 * Reads the snapshot of a run. A run created before C6b has none: that is a first-class answer
 * (`legacy_no_snapshot`), not an error, so old runs stay readable instead of turning into 500s.
 */
export async function readSnapshotForRun(
  store: ExecutionSnapshotReadPort,
  companyId: string,
  runId: string,
): Promise<SnapshotReadResult> {
  const snapshot = await store.getSnapshotForRun(companyId, runId);
  if (!snapshot) return { kind: "legacy_no_snapshot", runId };
  return { kind: "snapshot", snapshotId: snapshot.id, payload: snapshot.payload };
}

// --- C10: the resume-time environment re-check ---------------------------------------------------------

import type { ExecutionSnapshotDiff, ExecutionSnapshotRecord } from "@npati/workspace";

/**
 * C10 (Question 2): the environment facts a **resume** can genuinely re-read.
 *
 * These are deliberately *not* `ExecutionSnapshotSources`. Those describe a run **in flight**: the admitted
 * image digest, the system prompt version and the model profile version are published by the runner through a
 * per-run holder and exist only while that process lives. Re-collecting them after the process is gone would
 * record `null` for each of them, and the diff against the recorded snapshot would then report a change for
 * every one of those fields — a false alarm on every single resume, which is worse than not checking at all.
 *
 * So a resume records the four families it can really answer, under their **own keys**, which are the same keys
 * the run snapshot uses. The diff is therefore like-for-like, and a family that cannot be read is reported as
 * `not compared` with its reason rather than as "unchanged".
 */
export interface ResumeEnvironmentSources {
  /** Resolved feature flags in force now (master + sub-flags), in the shape the run snapshot recorded them. */
  featureFlags(input: ResumeEnvironmentReadInput): Promise<Record<string, unknown> | null>;
  /** The policy composition in force now, from the one composition builder the run snapshot uses. */
  policyComposition(input: ResumeEnvironmentReadInput): Promise<Record<string, unknown> | null>;
  /** The provider/data policy in force now: the governing version and the classification actually applied. */
  providerDataPolicy(input: ResumeEnvironmentReadInput): Promise<{ version: number | null; classification: string | null } | null>;
  /**
   * Whether the sandbox image the run was admitted with may still be used. Revocation is its own answer and
   * cannot be expressed as a diff: a changed digest and a revoked digest look identical field-by-field, and only
   * one of them must stop the continuation.
   */
  sandboxImage(input: ResumeEnvironmentReadInput): Promise<ResumeSandboxImageFact | null>;
}

export interface ResumeEnvironmentReadInput {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  /** The snapshot the run was admitted under — the comparison base. `null` when the run has none. */
  recorded: Record<string, unknown> | null;
}

export interface ResumeSandboxImageFact {
  /** The digest the run recorded, when the checker could name it. */
  recordedDigest: string | null;
  /** What the admission policy says about that image **now**. */
  status: "admitted" | "revoked" | "unknown";
  replacement: string | null;
  reason: string;
}

/**
 * The families the resume comparison covers, split by **how** they can be compared.
 *
 * `featureFlags`, `policyComposition` and `providerDataPolicy` are values: yesterday's and today's are the same
 * kind of thing, so a field-by-field diff between them is meaningful.
 *
 * The sandbox image is deliberately **not** in that set. The run recorded `{ digest, sbomRef }` and a resume can
 * only ask the admission policy for a *verdict* (`admitted` / `revoked` / `unknown` plus a replacement). Those
 * two shapes share no field, so diffing them would report every field as changed on every resume — noise that
 * would bury the one fact that matters. Revocation is therefore reported as its own verdict, which is also the
 * only correct reading: a replaced digest and a revoked one are identical field by field, and only one of them
 * may continue.
 */
export const RESUME_ENVIRONMENT_DIFF_FAMILIES: readonly string[] = [
  "featureFlags",
  "policyComposition",
  "providerDataPolicy",
];

/** The sandbox image family: recorded by the resume snapshot, reported as a verdict rather than as a diff. */
export const RESUME_ENVIRONMENT_IMAGE_FAMILY = "sandboxImage";

/** Every family a resume snapshot records, so a reader can see the whole environment it describes. */
export const RESUME_ENVIRONMENT_FAMILIES: readonly string[] = [
  ...RESUME_ENVIRONMENT_DIFF_FAMILIES,
  RESUME_ENVIRONMENT_IMAGE_FAMILY,
];

/**
 * Assembles the payload of a **resume** snapshot.
 *
 * It reuses the same schema version, the same `{ unavailable }` marker for a source that failed, the same
 * secret scan and the same store write as the run snapshot — there is no second snapshot mechanism, only a
 * second, honest source set for a moment when the run-scoped one no longer exists.
 */
export async function collectResumeSnapshotPayload(input: {
  sources: ResumeEnvironmentSources;
  readInput: ResumeEnvironmentReadInput;
  actor: string;
  role: string | null;
  agentId?: string;
  now: Date;
  reason: string;
}): Promise<{ payload: ExecutionSnapshotPayload; unavailable: string[] }> {
  const unavailable: string[] = [];
  const s = input.sources;
  const read = input.readInput;
  const payload: ExecutionSnapshotPayload = {
    snapshotSchemaVersion: EXECUTION_SNAPSHOT_SCHEMA_VERSION,
    trigger: "resume",
    createdAt: input.now.toISOString(),
    actor: input.actor,
    actorRole: input.role,
    agentId: input.agentId ?? null,
    reason: input.reason,
    featureFlags: await readSource("featureFlags", () => s.featureFlags(read), unavailable),
    policyComposition: await readSource("policyComposition", () => s.policyComposition(read), unavailable),
    providerDataPolicy: await readSource("providerDataPolicy", () => s.providerDataPolicy(read), unavailable),
    sandboxImage: await readSource("sandboxImage", () => s.sandboxImage(read), unavailable),
  };
  return { payload, unavailable };
}

/**
 * The port the resume service consumes. Three methods, all of them the existing mechanism: the store's read, the
 * store's write (which is what versions the snapshot, links it to its predecessor and hashes it) and the store's
 * own content-safe diff. The service never compares payloads itself and never builds a second snapshot store.
 */
export interface ResumeEnvironmentAdmission {
  /** The snapshot the run was admitted under, or `null` when the run has none (recorded before C6b). */
  read(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null>;
  /** Creates the NEXT version for the session with `trigger: "resume"`; `null` when it cannot be recorded. */
  capture(input: {
    ctx: AuthContext;
    companyId: string;
    workspaceId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    actor: string;
    role?: string | null;
    reason: string;
    recorded: Record<string, unknown> | null;
  }): Promise<{ record: ExecutionSnapshotRecord; unavailable: string[] } | null>;
  /** The store's diff, so a caller sees exactly the change detection the Run Trace compare surface shows. */
  diff(before: ExecutionSnapshotRecord, after: ExecutionSnapshotRecord): ExecutionSnapshotDiff;
}

/**
 * The store surface the resume environment admission needs: the run's snapshot (the comparison base), the
 * versioned write, and the store's own content-safe diff. Declared structurally rather than by extending
 * `ExecutionSnapshotPersistPort`, because that port's read is deliberately narrow (`{ id, payload }`) for
 * read-only surfaces while a diff needs the versioned record.
 */
export interface ResumeEnvironmentAdmissionStore {
  getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null>;
  createExecutionSnapshot(input: {
    companyId: string;
    workspaceId: string;
    projectId: string;
    sessionId: string;
    runId?: string | null;
    payload: Record<string, unknown>;
    trigger: "session_start" | "run_start" | "config_change" | "resume" | "recovery";
    createdBy: string;
    now?: Date;
    id?: string;
  }): Promise<ExecutionSnapshotRecord>;
  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff;
}

/**
 * Builds the resume environment admission from the existing snapshot store and the resume-time sources.
 *
 * The failure rule matches the rest of the surface: `capture` returning `null` is "this deployment could not
 * record the environment", which the resume reports as un-checked — it never becomes "the environment is
 * unchanged", because a check that did not happen is not a clean bill of health.
 */
export function createResumeEnvironmentAdmission(input: {
  store: ResumeEnvironmentAdmissionStore;
  sources: ResumeEnvironmentSources;
  resolveRole?: (input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; runId: string }) => Promise<string | null>;
  now?: () => Date;
}): ResumeEnvironmentAdmission {
  return {
    read: async (companyId, runId) => input.store.getSnapshotForRun(companyId, runId),
    capture: async (request) => {
      const now = input.now?.() ?? new Date();
      let role: string | null = null;
      if (input.resolveRole) {
        try {
          role = await input.resolveRole({
            ctx: request.ctx, companyId: request.companyId, projectId: request.projectId,
            sessionId: request.sessionId, runId: request.runId,
          });
        } catch {
          role = null;
        }
      }
      const { payload, unavailable } = await collectResumeSnapshotPayload({
        sources: input.sources,
        readInput: {
          ctx: request.ctx, companyId: request.companyId, projectId: request.projectId,
          sessionId: request.sessionId, runId: request.runId, recorded: request.recorded,
        },
        actor: request.actor,
        role: request.role ?? role,
        now,
        reason: request.reason,
      });
      try {
        assertNoSecretsInSnapshot(payload);
      } catch {
        // A resume snapshot whose combination of facts carries a credential is not written at all: the value is
        // never stored, and "we refused to record the environment" is what the resume reports.
        return null;
      }
      const record = await input.store.createExecutionSnapshot({
        companyId: request.companyId,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        sessionId: request.sessionId,
        runId: request.runId,
        payload,
        trigger: "resume",
        createdBy: request.actor,
        now,
      });
      return { record, unavailable };
    },
    diff: (before, after) => input.store.diffExecutionSnapshots(before, after),
  };
}
