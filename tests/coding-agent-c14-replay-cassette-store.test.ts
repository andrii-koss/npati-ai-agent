import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { InMemoryWorkspaceStore } from "@npati/workspace";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  ReplayBundleRecorder,
  bundleHash,
  getReplayBundleById,
  readReplayBundle,
  replayInputHash,
  replayArgumentsHash,
  type ReplayBundlePersistPort,
} from "../apps/agent-api/src/code-replay-bundle";
import {
  CASSETTE_FILE_EXTENSION,
  REPLAY_CASSETTE_STORE_CODES,
  ReplayBundleFileError,
  ReplayBundleFileStore,
} from "../apps/agent-api/src/code-replay-cassette-store";

/**
 * C14 (owner decision 2): the **file-backed** replay-bundle port.
 *
 * The property this suite exists for is *equivalence*: a file cassette is not a second format and not a second
 * source of truth, it is the same serialized bundle (header, `payloadHash`, `replayInputHash`, ordered step
 * payloads) reached without a database. Every assertion below therefore compares the file store with the
 * database-shaped store over the **same recording**, or pins the failure modes of the file container itself
 * (corrupt, wrong container version, hostile run id, refused write) — the read path, the integrity check and the
 * tenant scoping are the existing module's, so they cannot differ here by construction.
 */

const COMPANY = "company-cassette";
const RUN = "run-cassette";
const SESSION = "session-cassette";
const PROJECT = "project-cassette";
const NOW = new Date("2026-03-01T00:00:00.000Z");
const LONG_RESULT = JSON.stringify({ ok: true, tool: "code.fs.read", result: "x".repeat(80), truncated: false });

/** Every temporary root this suite created, so the filesystem is left as it was found. */
const ROOTS: string[] = [];
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

/** A directory *inside* a fresh temporary root, so "nothing escaped" can be asserted on the root itself. */
function cassetteRoot(): { root: string; directory: string } {
  const root = mkdtempSync(path.join(tmpdir(), "npati-c14-cassette-store-"));
  ROOTS.push(root);
  return { root, directory: path.join(root, "cassettes") };
}

/**
 * One recording, written through whatever port is handed in. The exchange is a real one (a model step that asks
 * for a tool, the settled result the model saw, then the final answer), and the two argument hashes are derived
 * the way the runner really derives them: the model step holds the provider's argument **text**, the tool step
 * holds the **parsed** arguments, and both go through the one canonical conversion (`replayArgumentsHash`), so
 * one call carries one hash on either side — which is what a replay compares.
 */
async function recordExchange(store: ReplayBundlePersistPort, runId = RUN): Promise<{ bundleId: string }> {
  const rawArguments = JSON.stringify({ path: "src/index.ts" });
  const recorder = new ReplayBundleRecorder({
    store,
    context: {
      workspaceId: "ws-cassette",
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId,
      executionSnapshotId: "snapshot-1",
      runnerVersion: "runner-c14",
      systemPromptVersion: 2,
      systemPromptContentHash: "sha256:prompt-2",
      modelProfileVersion: 1,
      provider: "provider-a",
      model: "test-model",
      replayMode: "recorded",
      dataClassification: "confidential",
      retentionClass: "standard",
    },
    toolOutputChars: 64,
    now: () => NOW,
  });
  recorder.recordModelStep({
    turnIndex: 1,
    request: { model: "test-model", messageCount: 2, toolNames: ["code.fs.read"], idempotencyKey: `${SESSION}:${runId}:1`, dataClassification: "confidential" },
    response: {
      content: "I will read the file.",
      finishReason: "tool_calls",
      model: "test-model",
      provider: "provider-a",
      usage: { totalTokens: 12, promptTokens: 8, completionTokens: 4 },
      toolCalls: [{ id: "call-1", name: "code.fs.read", argumentsHash: replayArgumentsHash(rawArguments), arguments: rawArguments }],
    },
  });
  recorder.recordToolCall({
    turnIndex: 1,
    toolCallId: "call-1",
    tool: "code.fs.read",
    toolVersion: 3,
    argumentsHash: bundleHash({ path: "src/index.ts" }),
    settledResult: LONG_RESULT,
    outcome: "ok",
    truncated: false,
    durationMs: 5,
  });
  recorder.recordModelStep({
    turnIndex: 2,
    request: { model: "test-model", messageCount: 4, toolNames: ["code.fs.read"], idempotencyKey: `${SESSION}:${runId}:2`, dataClassification: "confidential" },
    response: { content: "The file exports one constant.", finishReason: "stop", model: "test-model", provider: "provider-a", usage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 }, toolCalls: [] },
  });
  const written = await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
  return { bundleId: written.bundleId ?? "" };
}

/** The one cassette file of a directory (the container writes exactly one per bundle). */
function cassetteFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((entry) => entry.endsWith(CASSETTE_FILE_EXTENSION));
}

function cassettePath(directory: string): string {
  return path.join(directory, cassetteFiles(directory)[0]!);
}

function readCassetteFile(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(cassettePath(directory), "utf8")) as Record<string, unknown>;
}

describe("security-gate: C14 file cassette — the same serialized bundle, without a database", () => {
  it("reads back through the existing reader exactly what the database-shaped store returns", async () => {
    const memory = new InMemoryWorkspaceStore();
    const { directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });

    await recordExchange(memory);
    await recordExchange(files);

    // The only port handed to the reader is the file store: no database, no in-memory store, nothing else.
    const fromFile = await readReplayBundle({ store: files, companyId: COMPANY, runId: RUN });
    const fromMemory = await readReplayBundle({ store: memory, companyId: COMPANY, runId: RUN });

    expect(fromFile.kind).toBe("bundle");
    expect(fromMemory.kind).toBe("bundle");
    // Same steps, same replay input, same hash, and no integrity failure on either side.
    expect(fromFile.steps).toEqual(fromMemory.steps);
    expect(fromFile.replayInput).toEqual(fromMemory.replayInput);
    expect(fromFile.replayInputHash).toBe(fromMemory.replayInputHash);
    expect(fromFile.replayInputHash).toBe(replayInputHash(fromFile.replayInput));
    expect(fromFile.integrityFailure).toBe(false);
    expect(fromFile.truncated).toBe(false);
    expect(fromFile.replayMode).toBe(fromMemory.replayMode);
    expect(fromFile.terminalStatus).toBe(fromMemory.terminalStatus);
    expect(fromFile.terminalReason).toBe(fromMemory.terminalReason);

    // The header the recorder handed to *both* stores is the same value. `payloadHash` is deliberately not on
    // the read port (the read path never uses it), so it is compared from the bytes each store really holds.
    const fileHeader = await files.getReplayBundle(COMPANY, RUN);
    const memoryHeader = await memory.getReplayBundle(COMPANY, RUN);
    expect(fileHeader?.bundleVersion).toBe(REPLAY_BUNDLE_FORMAT_VERSION);
    expect(fileHeader?.bundleVersion).toBe(memoryHeader?.bundleVersion);
    expect(fileHeader?.replayInputHash).toBe(memoryHeader?.replayInputHash);
    expect(fileHeader?.payload).toEqual(memoryHeader?.payload);
    expect(fileHeader?.payload).toMatchObject({ stepCount: 3, modelStepCount: 2, toolCallCount: 1 });
    expect(fileHeader?.runnerVersion).toBe("runner-c14");
    expect(fileHeader?.provider).toBe("provider-a");
    expect(fileHeader?.model).toBe("test-model");
    expect(fileHeader?.executionSnapshotId).toBe("snapshot-1");

    // The bytes on disk are the bundle, not a rendering of it.
    const onDisk = readCassetteFile(directory);
    const bundle = onDisk.bundle as Record<string, unknown>;
    const steps = onDisk.steps as Array<Record<string, unknown>>;
    expect(bundle.replayInputHash).toBe(fromMemory.replayInputHash);
    expect(bundle.payloadHash).toBe(memoryHeader?.payloadHash);
    expect(bundle.payload).toEqual(memoryHeader?.payload);
    expect(steps.map((step) => step.payload)).toEqual(fromMemory.steps);
    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3]);
    expect(steps.map((step) => step.kind)).toEqual(["model_step", "tool_call", "model_step"]);
    expect(steps.map((step) => step.payloadHash)).toEqual([bundleHash(fromMemory.steps[0]), bundleHash(fromMemory.steps[1]), bundleHash(fromMemory.steps[2])]);
  });

  it("is tenant-scoped in both directions and answers an unknown id like a bundle that never existed", async () => {
    const { directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });
    const written = await recordExchange(files);
    expect(written.bundleId).not.toBe("");

    const header = await files.getReplayBundle(COMPANY, RUN);
    expect(header).not.toBeNull();

    // Another tenant sees nothing: no header, no step, no replay, and `no_bundle` rather than an error.
    expect(await files.getReplayBundle("company-other", RUN)).toBeNull();
    expect(await files.getReplayBundleById("company-other", header!.id)).toBeNull();
    expect(await files.listReplayBundleSteps("company-other", header!.id)).toEqual([]);
    expect((await readReplayBundle({ store: files, companyId: "company-other", runId: RUN })).kind).toBe("no_bundle");
    expect((await getReplayBundleById({ store: files, companyId: "company-other", replayId: header!.id })).kind).toBe("no_bundle");

    // The owning tenant reads it by id and by run, through the same assembly path.
    const byId = await getReplayBundleById({ store: files, companyId: COMPANY, replayId: written.bundleId });
    expect(byId.kind).toBe("bundle");
    expect(byId.bundleId).toBe(written.bundleId);
    expect(byId.runId).toBe(RUN);
    expect(byId.steps).toEqual((await readReplayBundle({ store: files, companyId: COMPANY, runId: RUN })).steps);

    // An unknown id is the same answer as a foreign one: no existence oracle, and no error shape.
    const unknown = await getReplayBundleById({ store: files, companyId: COMPANY, replayId: "cassette-does-not-exist" });
    expect(unknown.kind).toBe("no_bundle");
    expect(unknown.steps).toEqual([]);
    expect((await readReplayBundle({ store: files, companyId: COMPANY, runId: "run-unknown" })).kind).toBe("no_bundle");
  });

  it("is append-only and idempotent: one bundle per run and version, and a newer version is a second bundle", async () => {
    const { directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });

    const first = await recordExchange(files);
    const second = await recordExchange(files);
    expect(second.bundleId).toBe(first.bundleId);
    expect(cassetteFiles(directory)).toHaveLength(1);

    const header = await files.getReplayBundle(COMPANY, RUN);
    const steps = await files.listReplayBundleSteps(COMPANY, header!.id);
    expect(steps.map((step) => step.kind)).toEqual(["model_step", "tool_call", "model_step"]);

    // A differently versioned bundle of the same run is stored beside it, and a version-less read answers the
    // newest one — the same "newest wins" the store's query gives.
    await files.createReplayBundle({
      workspaceId: "ws-cassette",
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId: RUN,
      bundleVersion: 4,
      replayMode: "recorded",
      payload: { stepCount: 1, modelStepCount: 1, toolCallCount: 0 },
      payloadHash: bundleHash({ stepCount: 1 }),
      replayInputHash: bundleHash({ steps: [] }),
      steps: [{ kind: "model_step", turnIndex: 1, payload: { kind: "model_step", turnIndex: 1 }, payloadHash: bundleHash({ kind: "model_step", turnIndex: 1 }) }],
      now: new Date("2026-03-02T00:00:00.000Z"),
    });
    expect(cassetteFiles(directory)).toHaveLength(2);
    expect((await files.getReplayBundle(COMPANY, RUN))?.bundleVersion).toBe(4);
    expect((await files.getReplayBundle(COMPANY, RUN, REPLAY_BUNDLE_FORMAT_VERSION))?.bundleVersion).toBe(REPLAY_BUNDLE_FORMAT_VERSION);

    // The store's unique index has a file equivalent: a repeated step identity is dropped, never duplicated.
    const deduped = await files.createReplayBundle({
      workspaceId: "ws-cassette",
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId: "run-deduped",
      bundleVersion: 1,
      replayMode: "recorded",
      payload: { stepCount: 2 },
      payloadHash: bundleHash({ stepCount: 2 }),
      replayInputHash: bundleHash({ steps: [] }),
      steps: [
        { kind: "tool_call", turnIndex: 1, toolCallId: "call-1", payload: { kind: "tool_call", turnIndex: 1, toolCallId: "call-1" }, payloadHash: bundleHash({ step: 1 }) },
        { kind: "tool_call", turnIndex: 1, toolCallId: "call-1", payload: { kind: "tool_call", turnIndex: 1, toolCallId: "call-1" }, payloadHash: bundleHash({ step: 1 }) },
      ],
      now: new Date("2026-03-03T00:00:00.000Z"),
    });
    const dedupedSteps = await files.listReplayBundleSteps(COMPANY, deduped.id);
    expect(dedupedSteps).toHaveLength(1);
    expect(dedupedSteps[0]?.seq).toBe(1);
  });

  it("fails loudly on a corrupt cassette instead of answering no_bundle", async () => {
    const { directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });
    await recordExchange(files);
    const filePath = cassettePath(directory);

    // Truncated JSON: a cassette that exists but cannot be understood is an error, never "this run was never
    // recorded" — that difference is the whole reason this file exists.
    writeFileSync(filePath, "{ \"cassetteFormat\": \"npati.code-replay-cassette\",", "utf8");
    const capture = async (read: () => Promise<unknown>): Promise<unknown> => {
      try {
        await read();
        return null;
      } catch (error) {
        return error;
      }
    };
    const failures = [
      await capture(() => readReplayBundle({ store: files, companyId: COMPANY, runId: RUN })),
      await capture(() => readReplayBundle({ store: files, companyId: COMPANY, runId: RUN, bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION })),
      await capture(() => getReplayBundleById({ store: files, companyId: COMPANY, replayId: "cassette-any" })),
    ];
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ReplayBundleFileError);
      const error = failure as ReplayBundleFileError;
      expect(error.code).toBe(REPLAY_CASSETTE_STORE_CODES.corrupt);
      // Metadata only: the broken document is not echoed back (a cassette may hold a model answer).
      expect(JSON.stringify(error.details)).not.toContain("cassetteFormat");
      expect(error.details.file).toBe(path.basename(filePath));
    }
    expect((failures[0] as ReplayBundleFileError).details.reason).toBe("invalid_json");

    // A file that is valid JSON but not a cassette, and one written by a newer container version.
    writeFileSync(filePath, JSON.stringify({ hello: "world" }), "utf8");
    await expect(readReplayBundle({ store: files, companyId: COMPANY, runId: RUN })).rejects.toMatchObject({
      code: REPLAY_CASSETTE_STORE_CODES.corrupt,
      details: { reason: "unknown_format" },
    });
    const unsupported = { cassetteFormat: "npati.code-replay-cassette", cassetteFileVersion: 99, bundle: {}, steps: [] };
    writeFileSync(filePath, JSON.stringify(unsupported), "utf8");
    await expect(readReplayBundle({ store: files, companyId: COMPANY, runId: RUN })).rejects.toMatchObject({
      code: REPLAY_CASSETTE_STORE_CODES.unsupported,
      details: { reason: "unsupported_container_version", expected: 1 },
    });
  });

  it("does not let one unreadable file break a read of another bundle, but never hides it either", async () => {
    const { directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });
    await recordExchange(files);
    // An unrelated, unreadable file: a scan must not attribute it to this run …
    writeFileSync(path.join(directory, `cassette-broken${CASSETTE_FILE_EXTENSION}`), "not json at all", "utf8");

    const byRun = await readReplayBundle({ store: files, companyId: COMPANY, runId: RUN });
    expect(byRun.kind).toBe("bundle");
    const byVersion = await readReplayBundle({ store: files, companyId: COMPANY, runId: RUN, bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION });
    expect(byVersion.integrityFailure).toBe(false);
    expect((await files.listBundles()).length).toBe(1);

    // … but a lookup that finds nothing while an unreadable file is present refuses instead of answering
    // "there was nothing", which is exactly the silent degradation a cassette must not allow.
    await expect(readReplayBundle({ store: files, companyId: COMPANY, runId: "run-not-here" })).rejects.toMatchObject({
      code: REPLAY_CASSETTE_STORE_CODES.corrupt,
      details: { reason: "invalid_json", file: `cassette-broken${CASSETTE_FILE_EXTENSION}` },
    });
  });

  it("keeps a hostile run or company id inside the cassette directory", async () => {
    const { root, directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });

    const hostileRun = "../../../evil";
    await recordExchange(files, hostileRun);
    // The bundle id is a digest of the triple, so an id can never become a path segment.
    expect(cassetteFiles(directory)).toHaveLength(1);
    expect(cassetteFiles(directory)[0]).toMatch(/^cassette-[0-9a-f]{32}\.cassette\.json$/);
    expect(readdirSync(root)).toEqual(["cassettes"]);

    const header = await files.getReplayBundle(COMPANY, hostileRun);
    expect(header).not.toBeNull();
    const read = await readReplayBundle({ store: files, companyId: COMPANY, runId: hostileRun });
    expect(read.kind).toBe("bundle");
    expect(read.runId).toBe(hostileRun);

    const hostileCompany = "..\\..\\company";
    await recordExchange(files, "run-2");
    expect((await readReplayBundle({ store: files, companyId: hostileCompany, runId: "run-2" })).kind).toBe("no_bundle");
    expect(readdirSync(root)).toEqual(["cassettes"]);
  });

  it("never leaves a partial cassette behind when a write is refused", async () => {
    const { directory } = cassetteRoot();
    const files = new ReplayBundleFileStore({ directory });

    // A payload JSON cannot serialize: the write is refused *before* anything lands, and the temporary file the
    // atomic write uses is not left behind either.
    const unserializable: Record<string, unknown> = { stepCount: 1, big: 1n };
    await expect(files.createReplayBundle({
      workspaceId: "ws-cassette",
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId: "run-refused",
      bundleVersion: 1,
      replayMode: "recorded",
      payload: unserializable,
      payloadHash: bundleHash({ refused: true }),
      replayInputHash: bundleHash({ steps: [] }),
      steps: [],
      now: NOW,
    })).rejects.toThrow();
    expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
    expect((await readReplayBundle({ store: files, companyId: COMPANY, runId: "run-refused" })).kind).toBe("no_bundle");
  });

  it("is deterministic across instances: the same recording in a second directory yields the same hashes", async () => {
    const first = cassetteRoot();
    const second = cassetteRoot();
    const firstStore = new ReplayBundleFileStore({ directory: first.directory });
    const secondStore = new ReplayBundleFileStore({ directory: second.directory });

    const writtenFirst = await recordExchange(firstStore);
    const writtenSecond = await recordExchange(secondStore);
    // The bundle id is derived from (company, run, version), so two processes agree on it without a database.
    expect(writtenSecond.bundleId).toBe(writtenFirst.bundleId);

    const firstRead = await readReplayBundle({ store: firstStore, companyId: COMPANY, runId: RUN });
    const secondRead = await readReplayBundle({ store: secondStore, companyId: COMPANY, runId: RUN });
    expect(secondRead.replayInputHash).toBe(firstRead.replayInputHash);
    expect(secondRead.replayInput).toEqual(firstRead.replayInput);
    expect(readFileSync(cassettePath(first.directory), "utf8")).toBe(readFileSync(cassettePath(second.directory), "utf8"));
  });
});
