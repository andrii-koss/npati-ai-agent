import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { PatchMutation } from "./code-patch-transaction";

interface Snapshot extends PatchMutation { originalMode?: number }
interface Journal { version: 1; state: "pending" | "committed"; files: Snapshot[] }
export interface WorkspacePatchIO {
  target(file: string): Promise<{ absolute: string }>;
  bytes(absolute: string): Promise<Buffer>;
  save(absolute: string, content: string, mode?: number): Promise<Buffer>;
  revision(bytes: Buffer): string;
  validate(file: string): string;
  error(code: string, message: string, currentRevision?: string): Error;
}
const journalName = ".npati-patch-transaction.json";
const maxJournalBytes = 32 * 1024 * 1024;

async function exists(absolute: string) {
  try { return await lstat(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function persist(base: string, journal: Journal) {
  const content = JSON.stringify(journal);
  if (Buffer.byteLength(content) > maxJournalBytes) throw new Error("Patch transaction journal exceeds its byte budget");
  const temporary = path.join(base, journalName + ".tmp");
  // A project process must never turn an internal journal into a symlink write.
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path.join(base, journalName));
}
function validateJournal(value: unknown, io: WorkspacePatchIO): Journal {
  const j = value as Journal;
  if (j?.version !== 1 || !["pending", "committed"].includes(j.state) || !Array.isArray(j.files) || j.files.length > 500) {
    throw io.error("transaction_recovery_required", "Invalid patch journal; workspace writes are blocked");
  }
  const seen = new Set<string>();
  for (const item of j.files) {
    if (!item || typeof item.path !== "string" || io.validate(item.path) !== item.path || seen.has(item.path) ||
      typeof item.before !== "string" || typeof item.after !== "string" || typeof item.existing !== "boolean" ||
      (item.originalMode !== undefined && (!Number.isInteger(item.originalMode) || item.originalMode < 0 || item.originalMode > 0o777))) {
      throw io.error("transaction_recovery_required", "Invalid patch journal entry; workspace writes are blocked");
    }
    seen.add(item.path);
  }
  return j;
}
async function restore(base: string, journal: Journal, io: WorkspacePatchIO) {
  // Inspect every target before restoring any of them. Preserve an uncoordinated
  // writer's bytes and retain the journal for explicit recovery instead of losing data.
  const targets: Array<{ item: Snapshot; absolute: string; unchanged: boolean }> = [];
  for (const item of journal.files) {
    const { absolute } = await io.target(item.path);
    const entry = await exists(absolute);
    if (entry && !entry.isFile()) throw io.error("transaction_recovery_required", "Patch recovery target is not a regular file");
    const content = entry ? await io.bytes(absolute) : undefined;
    const unchanged = item.existing ? content?.equals(Buffer.from(item.before, "utf8")) === true : !entry;
    const isApplied = item.delete ? !entry : content?.equals(Buffer.from(item.after, "utf8")) === true;
    if (!unchanged && !isApplied) throw io.error("transaction_recovery_required", "Patch recovery conflicts with an external writer; journal retained");
    targets.push({ item, absolute, unchanged });
  }
  for (const { item, absolute, unchanged } of targets.reverse()) {
    if (unchanged) continue;
    if (item.existing) await io.save(absolute, item.before, item.originalMode);
    else await rm(absolute);
  }
  await rm(path.join(base, journalName));
}

/** Called only while holding the existing cross-process workspace write lease. */
async function recoverPatch(base: string, io: WorkspacePatchIO) {
  const file = path.join(base, journalName), entry = await exists(file);
  if (!entry) {
    // A crash before publishing the journal cannot have touched project files.
    const temporary = path.join(base, journalName + ".tmp");
    const orphan = await exists(temporary);
    if (orphan) {
      if (!orphan.isFile() || orphan.isSymbolicLink()) throw io.error("transaction_recovery_required", "Unsafe patch journal temporary file");
      await rm(temporary);
    }
    return;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxJournalBytes) {
    throw io.error("transaction_recovery_required", "Unsafe patch journal; workspace writes are blocked");
  }
  const journal = validateJournal(JSON.parse(await readFile(file, "utf8")), io);
  if (journal.state === "committed") await rm(file);
  else await restore(base, journal, io);
  const temporary = path.join(base, journalName + ".tmp");
  const orphan = await exists(temporary);
  if (orphan) {
    if (!orphan.isFile() || orphan.isSymbolicLink()) throw io.error("transaction_recovery_required", "Unsafe patch journal temporary file");
    await rm(temporary);
  }
}

/** Atomic failure recovery for writers participating in the workspace lease.
 * Direct filesystem/terminal writers do not participate: a conflict fails closed.
 * The fsynced intent survives worker death; this is not a host power-loss guarantee.
 */
export async function commitWorkspacePatch(base: string, plan: readonly PatchMutation[], io: WorkspacePatchIO) {
  const files: Snapshot[] = [], seen = new Set<string>();
  for (const item of plan) {
    const clean = io.validate(item.path);
    if (seen.has(clean)) throw io.error("patch_invalid", "Duplicate patch target");
    seen.add(clean);
    if (item.mode !== undefined && (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777)) throw io.error("invalid_mode", "Patch mode must contain ordinary permission bits only");
    const { absolute } = await io.target(clean), entry = await exists(absolute);
    if (entry && !entry.isFile()) throw io.error("invalid_path", "Patch target is not a regular file");
    const current = entry ? await io.bytes(absolute) : undefined;
    if (Boolean(entry) !== item.existing || (current && (!current.equals(Buffer.from(item.before, "utf8")) ||
      (item.revision !== undefined && io.revision(current) !== item.revision)))) {
      throw io.error("revision_conflict", "Patch target changed before transaction", current ? io.revision(current) : undefined);
    }
    files.push({ ...item, path: clean, ...(entry ? { originalMode: entry.mode & 0o777 } : {}) });
  }
  if (!files.length) return [];
  const journal: Journal = { version: 1, state: "pending", files };
  await persist(base, journal);
  const results: Array<{ path: string; sha256?: string; revision?: string }> = [];
  try {
    for (const item of files) {
      const { absolute } = await io.target(item.path);
      // Recheck immediately before mutation; lease-external writes must not be overwritten.
      const entry = await exists(absolute);
      const bytes = entry ? await io.bytes(absolute) : undefined;
      if (Boolean(entry) !== item.existing || (bytes && !bytes.equals(Buffer.from(item.before, "utf8")))) {
        throw io.error("revision_conflict", "External writer changed a patch target", bytes ? io.revision(bytes) : undefined);
      }
      if (item.delete) { await rm(absolute); results.push({ path: item.path }); }
      else {
        const saved = await io.save(absolute, item.after, item.originalMode ?? item.mode);
        const revision = io.revision(saved);
        results.push({ path: item.path, sha256: revision, revision });
      }
    }
    await persist(base, { ...journal, state: "committed" });
  } catch (error) {
    try { await restore(base, journal, io); }
    catch { throw io.error("transaction_recovery_required", "Patch failed; journal retained and workspace writes blocked until recovery succeeds"); }
    throw error;
  }
  // The commit marker is authoritative even when journal cleanup fails.
  await rm(path.join(base, journalName)).catch(() => undefined);
  return results;
}

/** Recovery errors never expose journal contents or permit subsequent writes. */
export async function recoverWorkspacePatch(base: string, io: WorkspacePatchIO) {
  try { await recoverPatch(base, io); }
  catch { throw io.error("transaction_recovery_required", "Unfinished patch could not be recovered; journal retained and workspace access blocked"); }
}
