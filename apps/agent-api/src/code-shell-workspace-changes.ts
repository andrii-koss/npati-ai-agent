import { createHash } from "node:crypto";
import { buildUnifiedDiff, diffLineStats } from "./code-tools-diff";
import { isSensitivePath } from "./code-tools-sensitive";
import { normalizeWorkspacePath } from "./code-tools-path";
import { scanTextForSecrets } from "./code-secret-scanner";
import { isSandboxWorkspaceArtifact } from "./project-sandbox-service";
import type { CodeWriteChange } from "./code-workspace-checkpoint";

export interface ShellChangePort {
  listFiles(): Promise<readonly { path: string }[]>;
  readFile(path: string): Promise<{ content: string }>;
  record(change: CodeWriteChange): void;
}

/** Foreground shell mutations need the same trusted change receipts as file tools. */
export async function withTrackedShellChanges<T>(port: ShellChangePort, execute: () => Promise<T>): Promise<T> {
  const capture = async () => {
    const files = (await port.listFiles()).filter(file => !isSandboxWorkspaceArtifact(file.path) && !isSensitivePath(file.path));
    if (files.length > 2000) throw new Error("shell_change_capture_limit");
    const snapshot = new Map<string, string>();
    let bytes = 0;
    for (const file of files) {
      const path = normalizeWorkspacePath(file.path, { tool: "code.fs.diff", allowEmpty: false });
      const { content } = await port.readFile(path);
      bytes += Buffer.byteLength(content);
      if (bytes > 32 * 1024 * 1024) throw new Error("shell_change_capture_limit");
      snapshot.set(path, content);
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
