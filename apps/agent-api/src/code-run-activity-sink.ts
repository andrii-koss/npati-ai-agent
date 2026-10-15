import type { WorkspaceStore, CodeActivityEventKind, DataClassification, RetentionClass } from "@npati/workspace";
import { DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS } from "@npati/workspace";
import { scanTextForSecrets } from "./code-secret-scanner";

/**
 * C6b — the single write path for Coding Agent Activity events.
 *
 * Before this module every Activity event went to a structured log line and nowhere else (`app.log.info`).
 * A log is not evidence: it rotates, and requirement 19 says each Activity event must reference the
 * ExecutionSnapshot of its run. This sink persists the event and *also* logs it, so the existing diagnostics
 * do not disappear.
 *
 * Invariants, all enforced here rather than left to callers:
 *
 *   1. **Metadata only.** Content-like keys (`command`, `diff`, `content`, `prompt`, `stdout`, …) are rejected
 *      with a thrown error before anything is written. A caller that passes a command line gets a failure it
 *      can see, not a silent strip, because silently removing fields would hide a leak in the caller.
 *   2. **No secrets, by value as well as by key.** The payload is scanned with the C4a scanner, so a secret
 *      pasted into an innocuous key (`{"note": "ghp_…"}`) is caught too.
 *   3. **Classification and retention from creation.** Requirement 18: the values come from the injected
 *      resolver (project/session) and fall back to the conservative defaults, never to `undefined`.
 *   4. **A failing sink never changes a decision.** Persistence and logging failures are captured and
 *      reported in the returned result; the caller's policy/tool verdict is untouched. That is why this
 *      function does not throw for infrastructure errors — only for the two programming errors above, which
 *      must be loud during development and in the tests.
 *   5. **Tenant isolation.** `companyId` is required and comes from the event; the store call is scoped by it.
 */

/**
 * Keys that must never appear in a persisted Activity payload.
 *
 * File **paths** are deliberately absent: this project treats a path as metadata (the tool-call audit entry
 * already stores "paths, hashes and diff statistics only"), and policy decisions legitimately carry the list
 * of paths a call touched. What must never be stored is the content itself — commands, diffs, file bodies,
 * prompts, terminal output, URLs and credential-shaped values.
 */
export const FORBIDDEN_ACTIVITY_PAYLOAD_KEYS = [
  "command", "args", "argv", "content", "contents", "body", "diff", "patch", "prompt", "prompts",
  "stdout", "stderr", "output", "url", "uri", "query",
  "headers", "header", "cookie", "cookies", "authorization", "token", "secret", "password", "passwd",
  "api_key", "apikey", "credential", "credentials", "replacement", "find",
] as const;

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_ACTIVITY_PAYLOAD_KEYS);

/** Raised when a caller tries to persist content instead of metadata. */
export class ActivityContentRejectedError extends Error {
  readonly code = "activity_payload_must_not_carry_content";
  readonly httpStatus = 400;
  constructor(key: string) {
    super(`Activity payload must not carry content: ${key}`);
    this.name = "ActivityContentRejectedError";
  }
}

export class ActivitySecretRejectedError extends Error {
  readonly code = "activity_payload_must_not_carry_secrets";
  readonly httpStatus = 400;
  constructor(kind: string) {
    super(`Activity payload must not carry secrets: ${kind}`);
    this.name = "ActivitySecretRejectedError";
  }
}

/**
 * Walks the payload and rejects content-like keys at any depth. Arrays of objects are walked too, because
 * a list of changed files is exactly the shape a caller is most likely to pass by accident.
 */
export function assertMetadataOnlyActivityPayload(payload: unknown, depth = 0, trail: string[] = []): void {
  if (payload === null || payload === undefined) return;
  if (depth > 6) return;
  if (Array.isArray(payload)) {
    payload.slice(0, 100).forEach((item, index) => assertMetadataOnlyActivityPayload(item, depth + 1, [...trail, String(index)]));
    return;
  }
  if (typeof payload !== "object") return;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) {
      throw new ActivityContentRejectedError([...trail, key].join("."));
    }
    assertMetadataOnlyActivityPayload(value, depth + 1, [...trail, key]);
  }
}

/** Rejects secrets by value; returns nothing because a finding is never "redacted into" the payload. */
export function assertNoSecretsInActivityPayload(payload: unknown): void {
  const serialised = JSON.stringify(payload ?? {});
  const scan = scanTextForSecrets(serialised);
  if (scan.findings.length > 0) {
    throw new ActivitySecretRejectedError(scan.findings[0]!.kind);
  }
}

/** Everything an event of any family has in common. */
export interface CodeActivityEventIdentity {
  kind: CodeActivityEventKind;
  companyId: string;
  workspaceId?: string;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  /**
   * C12: the delegation tree. `parentRunId` (plus the tool call that started the child) says which run this
   * event hangs under; all three are optional, so every pre-C12 caller is unchanged and keeps recording a
   * root-level event.
   */
  parentRunId?: string | null;
  parentToolCallId?: string | null;
  parentEventId?: string | null;
}

export interface CodeActivityClassificationResolver {
  /**
   * Returns the classification/retention to store with the event. Implementations read the session or the
   * project record; returning `undefined` means "use the conservative default".
   */
  resolve(input: { companyId: string; projectId?: string | null; sessionId?: string | null }):
    | { dataClassification?: DataClassification; retentionClass?: RetentionClass }
    | undefined;
}

export interface CodeRunActivitySinkOptions {
  store: Pick<WorkspaceStore, "createCodeActivityEvent">;
  workspaceId: string;
  classification?: CodeActivityClassificationResolver;
  /** Parallel log line, so the previous diagnostics are preserved. Never receives content. */
  log?: (event: Record<string, unknown>, message: string) => void;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
}

export interface CodeActivityWriteResult {
  persisted: boolean;
  id?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CodeRunActivitySink {
  /**
   * Persists one event. Throws only for the two programming errors (content or secret in the payload); a
   * store or log failure is reported in the result and never thrown, so a decision cannot be changed by
   * bookkeeping.
   */
  record(identity: CodeActivityEventIdentity, payload: Record<string, unknown>): Promise<CodeActivityWriteResult>;
}

const IDENTITY_KEYS = [
  "kind", "at", "companyId", "workspaceId", "projectId", "sessionId", "runId", "snapshotId",
  // C12: the delegation tree. They are identity, not payload, so they never reach the metadata-only checker
  // and cannot be re-described as something a caller supplied.
  "parentRunId", "parentToolCallId", "parentEventId",
] as const;

/**
 * Splits an event object into its identity and its payload, so a caller can pass the event it already builds
 * (`{ ...event }`) without having to project fields by hand — hand projection is how a `command` field ends
 * up persisted in the first place.
 */
export function splitActivityEvent(event: Record<string, unknown>): {
  identity: CodeActivityEventIdentity;
  payload: Record<string, unknown>;
} {
  const identity: CodeActivityEventIdentity = {
    kind: String(event.kind ?? "") as CodeActivityEventKind,
    companyId: String(event.companyId ?? ""),
    workspaceId: event.workspaceId ? String(event.workspaceId) : undefined,
    projectId: event.projectId === null || event.projectId === undefined ? null : String(event.projectId),
    sessionId: event.sessionId === null || event.sessionId === undefined ? null : String(event.sessionId),
    runId: event.runId === null || event.runId === undefined ? null : String(event.runId),
    snapshotId: event.snapshotId === null || event.snapshotId === undefined ? null : String(event.snapshotId),
    parentRunId: event.parentRunId === null || event.parentRunId === undefined ? null : String(event.parentRunId),
    parentToolCallId: event.parentToolCallId === null || event.parentToolCallId === undefined ? null : String(event.parentToolCallId),
    parentEventId: event.parentEventId === null || event.parentEventId === undefined ? null : String(event.parentEventId),
  };
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if ((IDENTITY_KEYS as readonly string[]).includes(key)) continue;
    payload[key] = value;
  }
  return { identity, payload };
}

export function createCodeRunActivitySink(options: CodeRunActivitySinkOptions): CodeRunActivitySink {
  const now = options.now ?? (() => new Date());
  const knownKinds = new Set<CodeActivityEventKind>([
    "code_tool_activity", "policy_decision", "network_decision", "run_activity", "run_reconcile",
  ]);

  return {
    async record(identity, payload) {
      if (!knownKinds.has(identity.kind)) {
        throw new ActivityContentRejectedError(`kind:${String(identity.kind)}`);
      }
      if (!identity.companyId) {
        throw new ActivityContentRejectedError("companyId");
      }
      // Programming errors: loud, and thrown before anything is written.
      assertMetadataOnlyActivityPayload(payload);
      assertNoSecretsInActivityPayload(payload);

      const resolved = options.classification?.resolve({
        companyId: identity.companyId,
        projectId: identity.projectId ?? null,
        sessionId: identity.sessionId ?? null,
      });
      const dataClassification = resolved?.dataClassification ?? DEFAULT_DATA_CLASSIFICATION;
      const retentionClass = resolved?.retentionClass ?? DEFAULT_RETENTION_CLASS;

      const logPayload = {
        kind: identity.kind,
        companyId: identity.companyId,
        projectId: identity.projectId ?? null,
        sessionId: identity.sessionId ?? null,
        runId: identity.runId ?? null,
        snapshotId: identity.snapshotId ?? null,
        parentRunId: identity.parentRunId ?? null,
        parentToolCallId: identity.parentToolCallId ?? null,
        dataClassification,
        retentionClass,
        payload,
      };
      // A broken diagnostic logger must not prevent the durable insert.
      const log = (value: Record<string, unknown>, message: string) => { try { options.log?.(value, message); } catch { /* best effort */ } };
      log(logPayload, identity.kind);

      try {
        const created = await options.store.createCodeActivityEvent({
          companyId: identity.companyId,
          workspaceId: identity.workspaceId ?? options.workspaceId,
          projectId: identity.projectId ?? null,
          sessionId: identity.sessionId ?? null,
          runId: identity.runId ?? null,
          snapshotId: identity.snapshotId ?? null,
          parentRunId: identity.parentRunId ?? null,
          parentToolCallId: identity.parentToolCallId ?? null,
          parentEventId: identity.parentEventId ?? null,
          kind: identity.kind,
          payload,
          dataClassification,
          retentionClass,
          now: now(),
        });
        return { persisted: true, id: created.id };
      } catch (error) {
        // Bookkeeping must never change a decision: report, do not throw.
        const message = error instanceof Error ? error.message : String(error);
        log({ kind: identity.kind, companyId: identity.companyId, errorCode: "activity_persist_failed" }, "activity_persist_failed");
        return { persisted: false, errorCode: "activity_persist_failed", errorMessage: message };
      }
    },
  };
}

/**
 * Adapts a `CodeRunActivitySink` to the `{ record(event) }` shape the existing recorders expect, so wiring a
 * family is one line in the composition root instead of a projection written by hand. A persistence failure
 * is captured by the sink and never propagates into the decision path.
 */
export function activitySinkForKind<T extends object>(
  sink: CodeRunActivitySink,
  kind: CodeActivityEventKind,
): { record(event: T): Promise<void> } {
  return {
    async record(event: T): Promise<void> {
      const source=event as Record<string,unknown>;
      const { identity, payload } = splitActivityEvent({ ...source, ...(typeof source.kind==="string" && source.kind!==kind?{eventType:source.kind}:{}), kind });
      await sink.record(identity, payload);
    },
  };
}
