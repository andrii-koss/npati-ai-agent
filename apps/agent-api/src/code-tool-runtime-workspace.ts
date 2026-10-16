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
    getFileTree(ctx: AuthContext, companyId: string, projectId: string): Promise<Array<{ path: string; type: string; size?: number }>>;
    readFile(ctx: AuthContext, companyId: string, projectId: string, path: string): Promise<{ path: string; content: string; size: number; revision: string }>;
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
        .map((entry) => ({ path: entry.path, type: entry.type === "directory" ? "directory" as const : "file" as const, size: entry.size }));
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
      return { path: file.path, content: text, revision: file.revision, sha256: sha256Hex(content), totalLines: lines.length, truncated };
    },
    async runSearch({ ctx, companyId, projectId, query, path, maxResults, timeoutMs, glob, type, ignoreCase, fixedStrings, contextLines }) {
      if (!sandbox) {
        throw new CodeToolError("sandbox_unavailable", "Text search requires the sandbox runner; it is not available in this deployment", 503, "execute", true);
      }
      if (typeof sandbox.search === "function") {
        return sandbox.search(ctx, companyId, { projectId, query, path, maxResults, timeoutMs, glob, type, ignoreCase, fixedStrings, contextLines });
      }
      const target = path && path !== "." ? `./${path}` : ".";
      const escaped = query.replace(/'/g, "'\\''");
      const result = await sandbox.execute(ctx, companyId, {
        projectId,
        command: `rg --line-number --no-heading --color=never --max-count ${maxResults} -e '${escaped}' ${target}`,
        timeoutMs,
      });
      const stdout = result.stdout ?? result.output ?? "";
      const matches = stdout.split("\n").filter(Boolean).slice(0, maxResults).map((line) => {
        const [file, lineNumber, ...rest] = line.split(":");
        return { path: file ?? "", line: Number.parseInt(lineNumber ?? "0", 10) || 0, text: rest.join(":").slice(0, 500) };
      });
      return { matches, truncated: matches.length >= maxResults };
    },
  };
}

/**
 * C3: write port over the existing `ProjectWorkspace` file API.
 */
export function createProjectWorkspaceWritePort(
  workspace: {
    writeFile(ctx: AuthContext, companyId: string, projectId: string, path: string, content: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    createFile(ctx: AuthContext, companyId: string, projectId: string, path: string, content: string): Promise<{ path: string; revision: string }>;
    editFile(ctx: AuthContext, companyId: string, projectId: string, path: string, find: string, replacement: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    deleteFile(ctx: AuthContext, companyId: string, projectId: string, path: string): Promise<void>;
  },
): CodeWritePort {
  const hashed = (file: { path: string; revision: string }) => ({ path: file.path, revision: file.revision, sha256: file.revision });
  return {
    async writeFile(input) {
      return hashed(await workspace.writeFile(input.ctx, input.companyId, input.projectId, input.path, input.content, input.expectedRevision));
    },
    async createFile(input) {
      return hashed(await workspace.createFile(input.ctx, input.companyId, input.projectId, input.path, input.content));
    },
    async editFile(input) {
      return hashed(await workspace.editFile(input.ctx, input.companyId, input.projectId, input.path, input.find, input.replacement, input.expectedRevision));
    },
    async moveFile(input) {
      return hashed(await workspace.moveFile(input.ctx, input.companyId, input.projectId, input.from, input.to, input.expectedRevision));
    },
    async deleteFile(input) {
      await workspace.deleteFile(input.ctx, input.companyId, input.projectId, input.path);
    },
  };
}
