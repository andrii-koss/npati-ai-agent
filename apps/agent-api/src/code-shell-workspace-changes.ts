import { createHash } from "node:crypto";
import { buildUnifiedDiff, diffLineStats } from "./code-tools-diff";
import { isSensitivePath } from "./code-tools-sensitive";
import { normalizeWorkspacePath } from "./code-tools-path";
import { scanTextForSecrets } from "./code-secret-scanner";
import { isSandboxWorkspaceArtifact } from "./project-sandbox-service";
import type { CodeWriteChange } from "./code-workspace-checkpoint";

export interface ShellChangePort {
  listFiles(): Promise<readonly { path: string; revision?: string }[]>;
  readFile(path: string): Promise<{ content: string }>;
  record(change: CodeWriteChange): void;
  /** Contents already read, by path and revision. Shared between commands so only changed files are read again. */
  cache?: ShellChangeCache;
}

const CACHE_MAX_CHARS = 256_000_000;
const READ_CONCURRENCY = 16;

/** Oldest entries leave first; a miss is only one more read. */
export class ShellChangeCache {
  private readonly entries = new Map<string, string>();
  private chars = 0;
  get(key: string): string | undefined { return this.entries.get(key); }
  set(key: string, content: string): void {
    if (this.entries.has(key)) return;
    this.entries.set(key, content);
    this.chars += content.length;
    for (const [oldest, value] of this.entries) {
      if (this.chars <= CACHE_MAX_CHARS) break;
      this.entries.delete(oldest);
      this.chars -= value.length;
    }
  }
}

/** Foreground shell mutations need the same trusted change receipts as file tools. */
export async function withTrackedShellChanges<T>(port: ShellChangePort, execute: () => Promise<T>): Promise<T> {
  const capture = async () => {
    const files = (await port.listFiles()).filter(file => !isSandboxWorkspaceArtifact(file.path) && !isSensitivePath(file.path));
    const snapshot = new Map<string, string>();
    for (let offset = 0; offset < files.length; offset += READ_CONCURRENCY) {
      await Promise.all(files.slice(offset, offset + READ_CONCURRENCY).map(async (file) => {
        const path = normalizeWorkspacePath(file.path, { tool: "code.fs.diff", allowEmpty: false });
        const key = file.revision ? `${path}|${file.revision}` : undefined;
        let content = key ? port.cache?.get(key) : undefined;
        if (content === undefined) {
          ({ content } = await port.readFile(path));
          if (key) port.cache?.set(key, content);
        }
        snapshot.set(path, content);
      }));
    }
    return snapshot;
  };
  const before = await capture();
  try { return await execute(); }
  finally {
    // A command may modify sources before returning a nonzero exit code or throwing.
    const after = await capture();
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(path) === after.get(path)) continue;
      const diff = buildUnifiedDiff(before.get(path) ?? "", after.get(path) ?? "", path);
      if (!scanTextForSecrets(path + "\n" + diff).clean) throw new Error("shell_change_secret");
      const stats = diffLineStats(diff);
      port.record({ path, tool: "code.shell.exec", sha256: after.has(path) ? createHash("sha256").update(after.get(path)!).digest("hex") : null,
        diff, linesAdded: stats.additions, linesRemoved: stats.deletions, at: new Date().toISOString() });
    }
  }
}
