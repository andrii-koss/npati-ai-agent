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
}): Promise<{ payload: ExecutionSnapshotPayload; unavailable: string[] }> {
  const unavailable: string[] = [];
  const s = input.sources;
  const readPolicyComposition = s.policyComposition;
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
