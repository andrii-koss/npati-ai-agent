import { createHash } from "node:crypto";
import type { CodeSession, DurableCodeProcess } from "@npati/workspace";
import { normalizeWorkspacePath } from "./code-tools-path";
import { isSandboxWorkspaceArtifact } from "./project-sandbox-service";
import { scanTextForSecrets } from "./code-secret-scanner";
import { simpleUnifiedDiff } from "./code-workspace-checkpoint";
import { parseStoredCodeSubagentChildOutcome } from "./code-process-completions";

export interface CollectedCodeChange { path: string; tool: string; status?: string; diff?: string }

/** Workspace/write-tracker evidence, never a diff supplied by a child model. No new storage. */
export async function collectAsyncOperationChanges(input: {
  session: CodeSession; operations: readonly DurableCodeProcess[];
  childChanges(sessionId: string): readonly CollectedCodeChange[];
  childFileCount?(runId: string): Promise<number | null>;
  listFiles(): Promise<readonly { path: string }[]>;
  readFile(path: string): Promise<{ content: string } | null>;
  diff(path: string): Promise<{ diff: string }>;
}): Promise<CollectedCodeChange[]> {
  const merged = new Map<string, CollectedCodeChange>();
  let files: readonly { path: string }[] | undefined;
  const guardedPath = (raw: string) => {
    const path = normalizeWorkspacePath(raw, { tool: "code.fs.diff", allowEmpty: false });
    if (!scanTextForSecrets(path).clean) throw new Error("collect_change_secret");
    return path;
  };
  const guarded = (change: CollectedCodeChange) => {
    const path = guardedPath(change.path);
    if (!scanTextForSecrets(path + "\n" + (change.diff ?? "")).clean) throw new Error("collect_change_secret");
    merged.set(path, { ...change, path });
  };
  for (const op of input.operations) {
    if (op.companyId !== input.session.companyId || op.projectId !== input.session.projectId || op.sessionId !== input.session.id) throw new Error("collect_change_scope");
    if (!op.completion?.admission) throw new Error("collect_change_not_admitted");
    if (op.kind === "subagent") {
      const evidence = op.child?.sessionId ? input.childChanges(op.child.sessionId) : [];
      for (const change of evidence) guarded(change);
      const outcome = parseStoredCodeSubagentChildOutcome(op.completion.result.output);
      const declaredCount = op.child && input.childFileCount ? await input.childFileCount(op.child.runId) : null;
      const knownPaths = new Set([...evidence.map(change => change.path), ...(outcome.filesChanged ?? []).filter((path): path is string => typeof path === "string")]);
      // C6 estimates persist a file COUNT, not paths. Recovery must not mistake that loss for zero writes.
      if (declaredCount !== null && declaredCount > knownPaths.size) throw new Error("collect_change_evidence_missing");
      if (input.childFileCount && declaredCount === null && op.delegation?.readOnly === false) throw new Error("collect_change_evidence_missing");
      for (const raw of outcome.filesChanged ?? []) {
        if (typeof raw !== "string") throw new Error("collect_change_path");
        const path = guardedPath(raw);
        if (evidence.some((change) => change.path === path && typeof change.diff === "string")) continue;
        const { diff } = await input.diff(path);
        // A restart without write evidence must not turn a child's change into "nothing to review".
        if (!diff) throw new Error("collect_change_evidence_missing");
        guarded({ path, tool: "code.agent.spawn_async", diff });
      }
    } else if (op.workspaceSnapshot) {
      if (op.workspaceSnapshot.mounted && op.workspaceSnapshot.version !== 2) throw new Error("collect_change_evidence_missing");
      files ??= await input.listFiles();
      const paths = new Set([...files.map((file) => file.path), ...op.workspaceSnapshot.files.map((file) => file.path)].filter(path => !isSandboxWorkspaceArtifact(path)));
      for (const raw of paths) {
        const path = guardedPath(raw);
        const original = op.workspaceSnapshot.files.find((file) => file.path === path);
        const current = await input.readFile(path);
        if (original?.hash === (current && createHash("sha256").update(current.content).digest("hex"))) continue;
        if (!original && !current) continue;
        let { diff } = await input.diff(path);
        // Git excludes untracked files; actual content plus the absent snapshot base is evidence.
        if (!diff && !original && current) diff = simpleUnifiedDiff("", current.content, path).diff;
        if (!diff) throw new Error("collect_change_evidence_missing");
        guarded({ path, tool: "code.shell.exec", status: !original ? "added" : !current ? "deleted" : "modified", diff });
      }
    }
  }
  return [...merged.values()];
}
