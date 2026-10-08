/**
 * C14 (owner decision 2): the **file-backed** `ReplayBundlePersistPort` — a provider cassette that needs no
 * database.
 *
 * Why this exists and what it is not. Until C14 the only implementation of the replay-bundle port was the
 * Postgres store, so a recorded exchange could only ever be read back by the deployment that recorded it. That
 * makes deterministic provider replay useless exactly where it is needed most: in a hermetic test, in CI, in a
 * fresh process, on a checkout with no database. This module closes that gap with **one** port implementation
 * over a directory of files.
 *
 * Three rules keep it from becoming a second format or a second source of truth:
 *
 *  1. **The file is the same serialized bundle, not another format.** The header and the ordered steps are the
 *     values `ReplayBundleRecorder` handed to `createReplayBundle`, stored verbatim (`payload`, `payloadHash`,
 *     `replayInputHash`, every step payload and its hash). Reads go through the module that already owns
 *     reading — `readReplayBundle` / `getReplayBundleById` in `code-replay-bundle.ts` — which is what makes the
 *     integrity check, the `no_bundle` answer, the tenant scoping and the replay-input derivation *identical*
 *     to the database path by construction: neither store hashes anything, both only return rows.
 *     `tests/coding-agent-c14-replay-cassette-store.test.ts` reads one recording through both stores and
 *     compares the two read results field by field.
 *  2. **`bundleVersion` and `REPLAY_BUNDLE_FORMAT_VERSION` are the format, not this file.** A file carries its
 *     own tiny envelope (`cassetteFormat`, `cassetteFileVersion`) so that a file which is not a cassette at
 *     all is refused loudly instead of being half-read. The envelope versions *the file container*; it never
 *     re-versions the bundle, and the bundle's own format version is stored and returned untouched.
 *  3. **Nothing is ever overwritten or deleted.** There is no update and no delete method (the interface has
 *     none), a second write for the same `(company, run, bundleVersion)` returns the stored bundle instead of
 *     appending a second one — the same idempotency the store's unique index provides — and a write lands
 *     through a temporary file plus a rename, so a crashed or refused write cannot leave a half-written bundle
 *     that would later read as a plausible one.
 *
 * Failure is loud, never silent. A cassette that exists but cannot be understood raises
 * `ReplayBundleFileError` — answering `no_bundle` for a corrupt file would turn "the recording is broken" into
 * "this run was never recorded", which is precisely the silent degradation this project refuses everywhere
 * else. (Only a file that provably belongs to *another* bundle is skipped while scanning; if a scan finds no
 * candidate but did meet unreadable files, the read refuses rather than claim there was nothing.)
 *
 * This module owns no hashing, no provider and no tool: it is storage. `code-replay-cassette.ts` is the
 * provider seam.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ReplayBundleHeaderRecord,
  ReplayBundlePersistPort,
  ReplayBundleReadPort,
} from "./code-replay-bundle";

/** The envelope of a cassette file. Its own version, deliberately separate from the bundle format version. */
export const CASSETTE_FILE_FORMAT = "npati.code-replay-cassette";
export const CASSETTE_FILE_VERSION = 1;
export const CASSETTE_FILE_EXTENSION = ".cassette.json";

export const REPLAY_CASSETTE_STORE_CODES = Object.freeze({
  /** The file exists but is not a cassette this module can read: truncated JSON, wrong envelope, missing field. */
  corrupt: "replay_cassette_file_corrupt",
  /** The file is a cassette, but of a container version this build does not understand. */
  unsupported: "replay_cassette_file_unsupported",
});

/**
 * Raised instead of degrading a read. `details` is metadata only — a file name (which is derived from a hash, so
 * it cannot echo a value), a field name and a short reason — never a byte of the recording, which may hold a
 * model answer or a tool result.
 */
export class ReplayBundleFileError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "ReplayBundleFileError";
    this.code = code;
    this.details = details;
  }
}

/** The persist call of the existing port, so this implementation cannot drift from the interface it serves. */
type ReplayBundlePersistInput = Parameters<ReplayBundlePersistPort["createReplayBundle"]>[0];
/** The step row of the existing read port, for the same reason. */
type ReplayBundleStepRow = Awaited<ReturnType<ReplayBundleReadPort["listReplayBundleSteps"]>>[number];

interface CassetteBundleHeader {
  id: string;
  companyId: string;
  runId: string;
  bundleVersion: number;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  executionSnapshotId: string | null;
  runnerVersion: string | null;
  systemPromptVersion: number | null;
  systemPromptContentHash: string | null;
  modelProfileVersion: number | null;
  provider: string | null;
  model: string | null;
  replayMode: string;
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  terminalStatus: string | null;
  terminalReason: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  replayInputHash: string;
  dataClassification: string | null;
  retentionClass: string | null;
  createdAt: string;
}

interface CassetteBundleStep {
  id: string;
  seq: number;
  kind: string;
  turnIndex: number;
  toolCallId: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
}

interface CassetteFile {
  cassetteFormat: string;
  cassetteFileVersion: number;
  bundle: CassetteBundleHeader;
  steps: CassetteBundleStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class ReplayBundleFileStore implements ReplayBundlePersistPort, ReplayBundleReadPort {
  private readonly directory: string;

  constructor(input: { directory: string }) {
    this.directory = path.resolve(input.directory);
  }

  /** The directory this store owns; a caller (and a test) may print it, nothing writes outside it. */
  get directoryPath(): string {
    return this.directory;
  }

  /**
   * The deterministic bundle id of `(company, run, bundleVersion)`.
   *
   * A file cassette addresses a bundle by that triple, so the id is derived from it: a second recording of the
   * same run resolves to the *same* bundle — the idempotency the database gets from its unique index — and the
   * file name is a hex digest, so a hostile run id (`../../etc/passwd`) cannot become a path segment. This is
   * the one place a bundle id is minted here; it is never read from a caller.
   */
  bundleIdFor(input: { companyId: string; runId: string; bundleVersion: number }): string {
    const digest = createHash("sha256")
      .update(`${input.companyId}\u0000${input.runId}\u0000${String(input.bundleVersion)}`, "utf8")
      .digest("hex");
    return `cassette-${digest.slice(0, 32)}`;
  }

  private pathForBundleId(bundleId: string): string {
    return path.join(this.directory, `${bundleId}${CASSETTE_FILE_EXTENSION}`);
  }

  private pathFor(input: { companyId: string; runId: string; bundleVersion: number }): string {
    return this.pathForBundleId(this.bundleIdFor(input));
  }

  /**
   * Writes the header and its ordered steps as one file, or returns the stored bundle when this run already has
   * one at this version (append-only, like the two tables). The write goes through a temporary file in the same
   * directory and a rename, so a reader never observes a partial cassette.
   */
  async createReplayBundle(input: ReplayBundlePersistInput): Promise<{ id: string }> {
    const id = this.bundleIdFor(input);
    const target = this.pathForBundleId(id);
    // Strict on purpose: an existing but unreadable cassette is evidence, and overwriting it would destroy it.
    const existing = this.readFileStrict(target);
    if (existing) return { id: existing.bundle.id };

    const now = input.now ?? new Date();
    const seen = new Set<string>();
    const steps: CassetteBundleStep[] = [];
    for (const step of input.steps) {
      // Mirrors the store's unique index on (bundleId, kind, turnIndex, toolCallId): a repeated step is dropped,
      // never duplicated, and `seq` stays the executed order.
      const identity = `${step.kind}:${String(step.turnIndex)}:${step.toolCallId ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const seq = steps.length + 1;
      steps.push({
        id: `${id}-step-${String(seq)}`,
        seq,
        kind: step.kind,
        turnIndex: step.turnIndex,
        toolCallId: step.toolCallId ?? null,
        payload: step.payload,
        payloadHash: step.payloadHash,
      });
    }

    const file: CassetteFile = {
      cassetteFormat: CASSETTE_FILE_FORMAT,
      cassetteFileVersion: CASSETTE_FILE_VERSION,
      bundle: {
        id,
        companyId: input.companyId,
        runId: input.runId,
        bundleVersion: input.bundleVersion,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        executionSnapshotId: input.executionSnapshotId ?? null,
        runnerVersion: input.runnerVersion ?? null,
        systemPromptVersion: input.systemPromptVersion ?? null,
        systemPromptContentHash: input.systemPromptContentHash ?? null,
        modelProfileVersion: input.modelProfileVersion ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        replayMode: input.replayMode,
        sourceRunId: input.sourceRunId ?? null,
        sourceSnapshotId: input.sourceSnapshotId ?? null,
        terminalStatus: input.terminalStatus ?? null,
        terminalReason: input.terminalReason ?? null,
        payload: input.payload,
        payloadHash: input.payloadHash,
        replayInputHash: input.replayInputHash,
        dataClassification: input.dataClassification ?? null,
        retentionClass: input.retentionClass ?? null,
        createdAt: now.toISOString(),
      },
      steps,
    };

    mkdirSync(this.directory, { recursive: true });
    const temporary = `${target}.tmp-${String(process.pid)}-${now.getTime().toString(36)}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      renameSync(temporary, target);
    } catch (error) {
      // A leftover temporary file must never mask the real failure, and it must never be readable as a bundle
      // (it has no extension the reader looks for). Best-effort removal, then the original error.
      try {
        rmSync(temporary, { force: true });
      } catch {
        // ignored on purpose: the write error below is the one a caller needs
      }
      throw error;
    }
    return { id };
  }

  /** The newest bundle of `(company, run)`, or the exact version when one is named. */
  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleHeaderRecord | null> {
    if (bundleVersion !== undefined) {
      const file = this.readFileStrict(this.pathFor({ companyId, runId, bundleVersion }));
      if (!file) return null;
      if (file.bundle.companyId !== companyId || file.bundle.runId !== runId || file.bundle.bundleVersion !== bundleVersion) {
        throw new ReplayBundleFileError(
          REPLAY_CASSETTE_STORE_CODES.corrupt,
          "A cassette file describes a different bundle than the path it is stored at",
          { file: path.basename(this.pathFor({ companyId, runId, bundleVersion })), reason: "bundle_identity_mismatch" },
        );
      }
      return headerOf(file.bundle);
    }
    const scan = this.scan();
    const matching = scan.files
      .filter((file) => file.bundle.companyId === companyId && file.bundle.runId === runId)
      .sort((left, right) => (left.bundle.bundleVersion === right.bundle.bundleVersion
        ? right.bundle.createdAt.localeCompare(left.bundle.createdAt)
        : right.bundle.bundleVersion - left.bundle.bundleVersion));
    if (!matching.length) {
      scan.throwIfUnreadableFilesWereSeen();
      return null;
    }
    return headerOf(matching[0]!.bundle);
  }

  /**
   * The same bundle addressed by its own id. Tenant-scoped exactly like the store: another company's cassette is
   * simply not found, so this cannot become an existence oracle.
   */
  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleHeaderRecord | null> {
    const scan = this.scan();
    const match = scan.files.find((file) => file.bundle.id === bundleId && file.bundle.companyId === companyId);
    if (!match) {
      scan.throwIfUnreadableFilesWereSeen();
      return null;
    }
    return headerOf(match.bundle);
  }

  /** Steps in the recorded (executed) order; another tenant's bundle has no steps for this caller. */
  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRow[]> {
    const scan = this.scan();
    const match = scan.files.find((file) => file.bundle.id === bundleId && file.bundle.companyId === companyId);
    if (!match) {
      scan.throwIfUnreadableFilesWereSeen();
      return [];
    }
    return [...match.steps]
      .sort((left, right) => left.seq - right.seq)
      .map((step) => ({
        id: step.id,
        seq: step.seq,
        kind: step.kind,
        turnIndex: step.turnIndex,
        toolCallId: step.toolCallId,
        payload: step.payload,
        payloadHash: step.payloadHash,
      }));
  }

  /** Every bundle in the directory, newest first. Not part of the port: a convenience for tooling and tests. */
  listBundles(): ReplayBundleHeaderRecord[] {
    return this.scan().files
      .sort((left, right) => right.bundle.createdAt.localeCompare(left.bundle.createdAt))
      .map((file) => headerOf(file.bundle));
  }

  /**
   * Reads the whole directory. Files that are not cassettes are collected rather than skipped silently: an
   * unreadable file that belongs to *another* bundle must not break this read, but a read that finds nothing
   * must never claim "there was nothing" while an unreadable file is present.
   */
  private scan(): { files: CassetteFile[]; throwIfUnreadableFilesWereSeen(): void } {
    if (!existsSync(this.directory)) return { files: [], throwIfUnreadableFilesWereSeen: () => undefined };
    const unreadable: ReplayBundleFileError[] = [];
    const files: CassetteFile[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(CASSETTE_FILE_EXTENSION)) continue;
      const absolute = path.join(this.directory, entry.name);
      try {
        const file = parseCassetteFile(readFileSync(absolute, "utf8"), entry.name);
        if (file) files.push(file);
      } catch (error) {
        if (error instanceof ReplayBundleFileError) unreadable.push(error);
        else throw error;
      }
    }
    return {
      files,
      throwIfUnreadableFilesWereSeen: () => {
        if (unreadable.length) throw unreadable[0];
      },
    };
  }

  /** A direct read of one known path: `null` when it does not exist, a loud error when it cannot be read. */
  private readFileStrict(absolute: string): CassetteFile | null {
    if (!existsSync(absolute)) return null;
    return parseCassetteFile(readFileSync(absolute, "utf8"), path.basename(absolute));
  }
}

/** The header fields the read path needs, and nothing else — the same shape both stores return. */
function headerOf(header: CassetteBundleHeader): ReplayBundleHeaderRecord {
  return {
    id: header.id,
    companyId: header.companyId,
    runId: header.runId,
    bundleVersion: header.bundleVersion,
    executionSnapshotId: header.executionSnapshotId,
    runnerVersion: header.runnerVersion,
    systemPromptVersion: header.systemPromptVersion,
    systemPromptContentHash: header.systemPromptContentHash,
    modelProfileVersion: header.modelProfileVersion,
    provider: header.provider,
    model: header.model,
    replayMode: header.replayMode,
    terminalStatus: header.terminalStatus,
    terminalReason: header.terminalReason,
    payload: header.payload,
    replayInputHash: header.replayInputHash,
  };
}

/**
 * Parses one cassette file. Every failure mode produces the same loud, metadata-only error, because a caller
 * cannot act on a half-read recording: a truncated JSON document, a file that is not a cassette, a container
 * version this build does not know, or a header/step field of the wrong type.
 */
function parseCassetteFile(text: string, fileName: string): CassetteFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette file is not readable JSON", {
      file: fileName,
      reason: "invalid_json",
    });
  }
  if (!isRecord(parsed)) {
    throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette file is not an object", {
      file: fileName,
      reason: "not_an_object",
    });
  }
  if (parsed.cassetteFormat !== CASSETTE_FILE_FORMAT) {
    throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette file carries an unknown envelope", {
      file: fileName,
      reason: "unknown_format",
    });
  }
  if (numberOrNull(parsed.cassetteFileVersion) !== CASSETTE_FILE_VERSION) {
    throw new ReplayBundleFileError(
      REPLAY_CASSETTE_STORE_CODES.unsupported,
      "A cassette file was written by a container version this build does not understand",
      { file: fileName, reason: "unsupported_container_version", expected: CASSETTE_FILE_VERSION },
    );
  }
  const rawBundle = parsed.bundle;
  if (!isRecord(rawBundle)) {
    throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette file has no bundle header", {
      file: fileName,
      reason: "missing_header",
    });
  }
  const bundleVersion = numberOrNull(rawBundle.bundleVersion);
  if (
    typeof rawBundle.id !== "string"
    || typeof rawBundle.companyId !== "string"
    || typeof rawBundle.runId !== "string"
    || bundleVersion === null
    || typeof rawBundle.payloadHash !== "string"
    || typeof rawBundle.replayInputHash !== "string"
    || !isRecord(rawBundle.payload)
  ) {
    throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette header is missing a required field", {
      file: fileName,
      reason: "invalid_header",
    });
  }
  if (!Array.isArray(parsed.steps)) {
    throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette file has no step list", {
      file: fileName,
      reason: "missing_steps",
    });
  }
  const steps: CassetteBundleStep[] = [];
  for (const rawStep of parsed.steps) {
    if (!isRecord(rawStep) || !isRecord(rawStep.payload)) {
      throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette step is malformed", {
        file: fileName,
        reason: "invalid_step",
      });
    }
    const seq = numberOrNull(rawStep.seq);
    const turnIndex = numberOrNull(rawStep.turnIndex);
    const kind = rawStep.kind;
    if (typeof rawStep.id !== "string" || seq === null || turnIndex === null || typeof kind !== "string" || typeof rawStep.payloadHash !== "string") {
      throw new ReplayBundleFileError(REPLAY_CASSETTE_STORE_CODES.corrupt, "A cassette step is missing a required field", {
        file: fileName,
        reason: "invalid_step",
        seq,
      });
    }
    steps.push({
      id: rawStep.id,
      seq,
      kind,
      turnIndex,
      toolCallId: stringOrNull(rawStep.toolCallId),
      payload: rawStep.payload,
      payloadHash: rawStep.payloadHash,
    });
  }
  return {
    cassetteFormat: CASSETTE_FILE_FORMAT,
    cassetteFileVersion: CASSETTE_FILE_VERSION,
    bundle: {
      id: rawBundle.id,
      companyId: rawBundle.companyId,
      runId: rawBundle.runId,
      bundleVersion,
      workspaceId: stringOrNull(rawBundle.workspaceId) ?? "",
      projectId: stringOrNull(rawBundle.projectId) ?? "",
      sessionId: stringOrNull(rawBundle.sessionId) ?? "",
      executionSnapshotId: stringOrNull(rawBundle.executionSnapshotId),
      runnerVersion: stringOrNull(rawBundle.runnerVersion),
      systemPromptVersion: numberOrNull(rawBundle.systemPromptVersion),
      systemPromptContentHash: stringOrNull(rawBundle.systemPromptContentHash),
      modelProfileVersion: numberOrNull(rawBundle.modelProfileVersion),
      provider: stringOrNull(rawBundle.provider),
      model: stringOrNull(rawBundle.model),
      replayMode: stringOrNull(rawBundle.replayMode) ?? "recorded",
      sourceRunId: stringOrNull(rawBundle.sourceRunId),
      sourceSnapshotId: stringOrNull(rawBundle.sourceSnapshotId),
      terminalStatus: stringOrNull(rawBundle.terminalStatus),
      terminalReason: stringOrNull(rawBundle.terminalReason),
      payload: rawBundle.payload,
      payloadHash: rawBundle.payloadHash,
      replayInputHash: rawBundle.replayInputHash,
      dataClassification: stringOrNull(rawBundle.dataClassification),
      retentionClass: stringOrNull(rawBundle.retentionClass),
      createdAt: stringOrNull(rawBundle.createdAt) ?? "",
    },
    steps,
  };
}
