/**
 * C2: read tracking for read-before-write enforcement (C3).
 *
 * The runner must be able to prove that a file was read (and at which content hash) before an edit is
 * applied. This is deliberately in-process only: C2 keeps no database state for it, and C3/C6a decide
 * whether the evidence has to survive a restart.
 */

export interface ReadRecord {
  path: string;
  sha256: string;
  revision: string;
  at: string;
}

export interface ReadTrackerOptions {
  /** How long a read stays fresh. Defaults to 2 hours (`NPATI_CODE_READ_TRACK_TTL_MS`). */
  ttlMs?: number;
  /** Maximum records per session; the oldest are evicted. Defaults to 500. */
  maxPerSession?: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_SESSION = 500;

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function resolveReadTrackerOptions(env: NodeJS.ProcessEnv = process.env): Required<ReadTrackerOptions> {
  return {
    ttlMs: positiveInt(Number.parseInt(env.NPATI_CODE_READ_TRACK_TTL_MS ?? "", 10), DEFAULT_TTL_MS),
    maxPerSession: positiveInt(Number.parseInt(env.NPATI_CODE_READ_TRACK_MAX ?? "", 10), DEFAULT_MAX_PER_SESSION),
  };
}

export class ReadTracker {
  private readonly records = new Map<string, Map<string, ReadRecord>>();
  private readonly ttlMs: number;
  private readonly maxPerSession: number;

  constructor(options: ReadTrackerOptions = {}) {
    this.ttlMs = positiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxPerSession = positiveInt(options.maxPerSession, DEFAULT_MAX_PER_SESSION);
  }

  record(sessionId: string, record: { path: string; sha256: string; revision?: string; at?: string }): ReadRecord {
    const entry: ReadRecord = {
      path: record.path,
      sha256: record.sha256,
      revision: record.revision ?? "",
      at: record.at ?? new Date().toISOString(),
    };
    const session = this.records.get(sessionId) ?? new Map<string, ReadRecord>();
    // Re-inserting refreshes the position, so eviction always removes the least recently read file.
    session.delete(entry.path);
    session.set(entry.path, entry);
    while (session.size > this.maxPerSession) {
      const oldest = session.keys().next();
      if (oldest.done) break;
      session.delete(oldest.value);
    }
    this.records.set(sessionId, session);
    return entry;
  }

  get(sessionId: string, path: string): ReadRecord | null {
    const entry = this.records.get(sessionId)?.get(path);
    if (!entry) return null;
    if (this.expired(entry)) {
      this.records.get(sessionId)?.delete(path);
      return null;
    }
    return entry;
  }

  list(sessionId: string): ReadRecord[] {
    const session = this.records.get(sessionId);
    if (!session) return [];
    const live: ReadRecord[] = [];
    for (const [path, entry] of session) {
      if (this.expired(entry)) session.delete(path);
      else live.push(entry);
    }
    return live;
  }

  /** True only when the file was read within the TTL *and* its content hash is unchanged. */
  isFresh(sessionId: string, path: string, sha256: string): boolean {
    const entry = this.get(sessionId, path);
    return Boolean(entry && entry.sha256 === sha256);
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.records.clear();
    else this.records.delete(sessionId);
  }

  private expired(entry: ReadRecord): boolean {
    const at = Date.parse(entry.at);
    return !Number.isFinite(at) || Date.now() - at > this.ttlMs;
  }
}
