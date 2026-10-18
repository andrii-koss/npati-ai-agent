import { parseCodeSearchOutput } from "./code-search-output";
import { normalizeWorkspacePath } from "./code-tools-path";
import type { AuthContext } from "@npati/workspace";
import type { CodeReadPort, CodeWritePort, SandboxExecPort } from "./code-tool-runtime-ports";
import { sha256Hex } from "./code-tool-runtime-guards";
import { CodeToolError } from "./code-tool-runtime-errors";

/**
 * Default read port: directory listing and file reads use the sanctioned workspace API, text search
 * needs the sandbox (`rg`), because no project code may run on the NPATI host.
 */
export function createProjectWorkspaceReadPort(
  workspace: {
    getFileTree(ctx: AuthContext, companyId: string, projectId: string): Promise<Array<{ path: string; type: string; size?: number; mtimeMs?: number }>>;
    readFile(ctx: AuthContext, companyId: string, projectId: string, path: string): Promise<{ path: string; content: string; size: number; revision: string; mode?: number; binary?: boolean; encoding?: string; mimeGuess?: string | null }>;
  },
  sandbox?: SandboxExecPort,
): CodeReadPort {
  return {
    async listDir({ ctx, companyId, projectId, path, limit }) {
      const entries = await workspace.getFileTree(ctx, companyId, projectId);
      const prefix = path && path !== "." ? `${path.replace(/\/$/, "")}/` : "";
      const filtered = entries
        .filter((entry) => entry.path.startsWith(prefix))
        .filter((entry) => {
          const rest = entry.path.slice(prefix.length);
          return rest.length > 0 && !rest.includes("/");
        })
        .map((entry) => ({ path: entry.path, type: entry.type === "directory" ? "directory" as const : "file" as const, size: entry.size, mtimeMs: entry.mtimeMs }));
      return { entries: typeof limit === "number" ? filtered.slice(0, limit) : filtered };
    },
    async readFile({ ctx, companyId, projectId, path, startLine, endLine, maxLines, maxBytes }) {
      const file = await workspace.readFile(ctx, companyId, projectId, path);
      const content = file.content ?? "";
      const lines = content.split("\n");
      const from = Math.max(0, (startLine ?? 1) - 1);
      const to = endLine ? Math.min(lines.length, endLine) : lines.length;
      let body = lines.slice(from, to);
      let truncated = false;
      if (body.length > maxLines) { body = body.slice(0, maxLines); truncated = true; }
      let text = body.join("\n");
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
        truncated = true;
      }
      return { path: file.path, content: text, revision: file.revision, sha256: file.binary ? file.revision : sha256Hex(content), totalLines: lines.length, truncated,
        ...(file.mode !== undefined ? { mode: file.mode } : {}),
        ...(file.binary !== undefined ? { binary: file.binary } : {}),
        ...(file.encoding !== undefined ? { encoding: file.encoding } : {}),
        ...(file.mimeGuess !== undefined ? { mimeGuess: file.mimeGuess } : {}) };
    },
    async runSearch({ ctx, companyId, projectId, query, path, maxResults, timeoutMs, glob, type, ignoreCase, fixedStrings, contextLines }) {
      if (!sandbox) {
        throw new CodeToolError("sandbox_unavailable", "Text search requires the sandbox runner; it is not available in this deployment", 503, "execute", true);
      }
      if (typeof sandbox.search === "function") {
        return sandbox.search(ctx, companyId, { projectId, query, path, maxResults, timeoutMs, glob, type, ignoreCase, fixedStrings, contextLines });
      }
      const target = path && path !== "." ? "./" + normalizeWorkspacePath(path, { tool: "code.fs.grep" }) : ".";
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      const args = ["rg", "--json", "--line-number", "--no-heading", "--color=never", "--max-count", String(maxResults)];
      if (ignoreCase) args.push("-i");
      if (fixedStrings) args.push("-F");
      if (contextLines) args.push("-C", String(Math.min(10, Math.max(0, contextLines))));
      if (glob !== undefined) args.push("--glob", quote(normalizeWorkspacePath(glob, { tool: "code.fs.grep", allowGlob: true })));
      if (type !== undefined) {
        if (!/^[a-zA-Z0-9_-]+$/.test(type)) throw new CodeToolError("invalid_arguments", "Invalid file type filter", 400);
        args.push("--type", quote(type));
      }
      args.push("-e", quote(query), "--", quote(target));
      const result = await sandbox.execute(ctx, companyId, { projectId, command: args.join(" "), timeoutMs });
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new CodeToolError("search_failed", "Sandbox search did not complete successfully", 503, "execute", true);
      return parseCodeSearchOutput(result.stdout ?? result.output ?? "", maxResults, contextLines ?? 0);
    },
  };
}

/**
 * C3: write port over the existing `ProjectWorkspace` file API.
 */
export function createProjectWorkspaceWritePort(
  workspace: {
    writeFile(ctx: AuthContext, companyId: string, projectId: string, path: string, content: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    createFile(ctx: AuthContext, companyId: string, projectId: string, path: string, content: string, workspaceId?: string, agentId?: string, mode?: number): Promise<{ path: string; revision: string }>;
    editFile(ctx: AuthContext, companyId: string, projectId: string, path: string, find: string, replacement: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    deleteFile(ctx: AuthContext, companyId: string, projectId: string, path: string, workspaceId?: string, agentId?: string, expectedRevision?: string): Promise<void>;
  },
): CodeWritePort {
  const hashed = (file: { path: string; revision: string }) => ({ path: file.path, revision: file.revision, sha256: file.revision });
  return {
    async writeFile(input) {
      return hashed(await workspace.writeFile(input.ctx, input.companyId, input.projectId, input.path, input.content, input.expectedRevision));
    },
    async createFile(input) {
      return hashed(await workspace.createFile(input.ctx, input.companyId, input.projectId, input.path, input.content, undefined, undefined, input.mode));
    },
    async editFile(input) {
      return hashed(await workspace.editFile(input.ctx, input.companyId, input.projectId, input.path, input.find, input.replacement, input.expectedRevision));
    },
    async moveFile(input) {
      return hashed(await workspace.moveFile(input.ctx, input.companyId, input.projectId, input.from, input.to, input.expectedRevision));
    },
    async deleteFile(input) {
      await workspace.deleteFile(input.ctx, input.companyId, input.projectId, input.path, undefined, undefined, input.expectedRevision);
    },
  };
}
