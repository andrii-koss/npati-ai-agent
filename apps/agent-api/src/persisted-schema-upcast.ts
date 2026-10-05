/**
 * C1a (part B): versioned persisted JSON formats.
 *
 * Persisted records (session transcripts, summaries, checkpoint metadata, model profiles, tool
 * results) carry a `schemaVersion`. Readers upcast old records on read instead of migrating history,
 * which keeps old runs and sessions readable after a schema change and keeps the audit trail
 * untouched. A payload written by a *newer* version is refused instead of being misread.
 */

export const PERSISTED_SCHEMA_VERSIONS = {
  sessionTranscript: 1,
  sessionSummary: 1,
  checkpointMetadata: 1,
  modelProfile: 1,
  toolResult: 1,
} as const;

export type PersistedSchemaKind = keyof typeof PERSISTED_SCHEMA_VERSIONS;

export class PersistedSchemaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) { super(message); }
}

/** One step of an upgrade chain: takes a v(N) payload and returns an equivalent v(N+1) payload. */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

/**
 * Upgrade chains, keyed by `kind` and by the source version.
 * v1 is the initial version of every format, so the chains are empty today; the mechanism and the
 * tests are ready for v2 (adding `1: (payload) => ({ ...payload, newField: default })`).
 */
export const UPCASTERS: Record<string, Record<number, Upcaster>> = {
  sessionTranscript: {},
  sessionSummary: {},
  checkpointMetadata: {},
  modelProfile: {},
  toolResult: {},
};

function currentVersion(kind: string, versions?: Record<string, number>): number {
  const table = versions ?? (PERSISTED_SCHEMA_VERSIONS as Record<string, number>);
  const version = table[kind];
  if (version === undefined) {
    throw new PersistedSchemaError("unknown_persisted_kind", `Unknown persisted schema kind: ${kind}`, 400);
  }
  return version;
}

function readVersion(payload: unknown): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PersistedSchemaError("invalid_persisted_payload", "Persisted payload must be an object", 400);
  }
  const raw = (payload as Record<string, unknown>).schemaVersion;
  if (raw === undefined || raw === null) return 1; // records written before versioning are v1
  const version = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(version) || version < 1) {
    throw new PersistedSchemaError("invalid_schema_version", `Invalid persisted schemaVersion: ${String(raw)}`, 400);
  }
  return version;
}

/**
 * Reads a persisted payload of any supported version and returns it at the current version.
 * - missing `schemaVersion` → treated as v1 and labelled;
 * - older than current → the registered upcasters are applied in order;
 * - equal to current → returned with the version field present;
 * - newer than current → `unsupported_schema_version` (never guess).
 */
export function upcastPersisted<T = Record<string, unknown>>(
  kind: PersistedSchemaKind | string,
  payload: unknown,
  options: { upcasters?: Record<string, Record<number, Upcaster>>; versions?: Record<string, number> } = {},
): T & { schemaVersion: number } {
  const target = currentVersion(kind, options.versions);
  const chain = (options.upcasters ?? UPCASTERS)[kind] ?? {};
  let data = { ...(payload as Record<string, unknown>) };
  let version = readVersion(payload);
  if (version > target) {
    throw new PersistedSchemaError(
      "unsupported_schema_version",
      `Persisted ${kind} has schemaVersion ${version} but this build supports up to ${target}`,
      409,
    );
  }
  while (version < target) {
    const step = chain[version];
    if (!step) {
      throw new PersistedSchemaError(
        "missing_upcaster",
        `No upcaster registered for ${kind} v${version} -> v${version + 1}`,
        500,
      );
    }
    data = step(data);
    version += 1;
  }
  return { ...(data as T), schemaVersion: version };
}

export function withSchemaVersion<T extends Record<string, unknown>>(kind: PersistedSchemaKind | string, payload: T): T & { schemaVersion: number } {
  return { ...payload, schemaVersion: currentVersion(kind) };
}