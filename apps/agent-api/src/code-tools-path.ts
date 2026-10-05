/**
 * C2: path safety for the read-only code tools.
 *
 * Every path that reaches a tool comes either from the model or from the frontend, so it is untrusted
 * input. This module is deliberately dependency-free and pure, so it can be unit-tested in isolation
 * and reused by later steps (write tools, C3) instead of being re-implemented per tool.
 *
 * Invariants:
 * - a tool never sees an absolute path, a drive letter, a UNC path or a `..` segment;
 * - a returned path is always workspace-relative and never carries a workspace prefix;
 * - escaping through a symlink is refused when the caller can tell us the link target.
 */

export type CodeToolErrorCode =
  | "invalid_path"
  | "path_outside_workspace"
  | "null_byte"
  | "symlink_escape"
  | "sensitive_file_denied"
  | "not_a_file"
  | "not_a_directory"
  | "too_large"
  | "read_failed"
  | "search_failed"
  | "invalid_argument";

/** Structured tool error: the shape the model receives instead of a stack trace. */
export class CodeToolError extends Error {
  readonly status = "error" as const;
  constructor(
    readonly code: CodeToolErrorCode,
    message: string,
    readonly tool: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    readonly step?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CodeToolError";
  }

  toJSON(): Record<string, unknown> {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      tool: this.tool,
      step: this.step ?? null,
      retryable: this.retryable,
      details: this.details ?? {},
    };
  }
}

export interface NormalizePathOptions {
  /** Tool name recorded in the error, never inferred from user input. */
  tool: string;
  /** When true, an empty path and "." both normalise to "." (directory-ish tools). */
  allowEmpty?: boolean;
  /** When true, glob metacharacters are preserved instead of being rejected. */
  allowGlob?: boolean;
  /** Maximum accepted length, to bound matcher work. */
  maxLength?: number;
}

const GLOB_META = /[*?[\]{}()!+@]/;
const DRIVE_PREFIX = /^[a-zA-Z]:/;

/**
 * Normalises and validates a workspace-relative path.
 * Throws `CodeToolError` with a precise code instead of guessing; callers never sanitise silently.
 */
export function normalizeWorkspacePath(raw: unknown, options: NormalizePathOptions): string {
  const tool = options.tool;
  if (typeof raw !== "string") {
    throw new CodeToolError("invalid_path", "Path must be a string", tool);
  }
  if (raw.length > (options.maxLength ?? 4096)) {
    throw new CodeToolError("invalid_path", "Path is too long", tool);
  }
  if (raw.includes("\0")) {
    throw new CodeToolError("null_byte", "Path contains a null byte", tool);
  }
  // Normalise Windows separators first so the checks below cannot be bypassed with backslashes.
  let value = raw.replace(/\\/g, "/").trim();
  if (!value || value === "." || value === "./") {
    if (options.allowEmpty === false) throw new CodeToolError("invalid_path", "A path is required", tool);
    return ".";
  }
  if (value.startsWith("~")) {
    throw new CodeToolError("path_outside_workspace", "Home-relative paths are not allowed", tool);
  }
  if (value.startsWith("/") || DRIVE_PREFIX.test(value) || value.startsWith("//")) {
    throw new CodeToolError("path_outside_workspace", "Absolute paths are not allowed; use a workspace-relative path", tool);
  }
  // Collapse repeated separators before segment checks so "a//../b" cannot hide a traversal.
  value = value.replace(/\/+/g, "/").replace(/\/+$/, "");
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new CodeToolError("path_outside_workspace", "Path traversal with \"..\" is not allowed", tool);
    }
    if (!options.allowGlob && GLOB_META.test(segment)) {
      throw new CodeToolError("invalid_path", "Glob metacharacters are not allowed in this path", tool);
    }
  }
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  if (!normalized) {
    if (options.allowEmpty === false) throw new CodeToolError("invalid_path", "A path is required", tool);
    return ".";
  }
  return normalized;
}

/** True when `target` is the workspace root itself or lives below it. */
export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const candidate = target.replace(/\\/g, "/");
  if (!root) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Refuses a symlink whose target leaves the workspace. The runtime reads the link target with
 * `readlink` and passes it here; a target we cannot resolve is treated as an escape (fail closed).
 */
export function assertSafeSymlink(input: { path: string; linkTarget: string | null | undefined; workspaceRoot?: string | null; tool: string }): void {
  const target = input.linkTarget;
  if (!target) {
    throw new CodeToolError("symlink_escape", `Symlink "${input.path}" is not followed (its target could not be verified)`, input.tool, 403);
  }
  const normalizedTarget = target.replace(/\\/g, "/");
  const escapes = normalizedTarget.startsWith("/")
    || DRIVE_PREFIX.test(normalizedTarget)
    || normalizedTarget.startsWith("//")
    || normalizedTarget.split("/").includes("..");
  if (escapes) {
    throw new CodeToolError("symlink_escape", `Symlink "${input.path}" points outside the workspace`, input.tool, 403);
  }
  if (input.workspaceRoot) {
    // A relative target is resolved against the link's own directory before the containment check.
    const linkDir = input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "";
    const resolved = `${linkDir ? `${linkDir}/` : ""}${normalizedTarget}`.replace(/\/+/g, "/");
    const parts: string[] = [];
    for (const segment of resolved.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    if (!isInsideWorkspace(input.workspaceRoot, parts.join("/"))) {
      throw new CodeToolError("symlink_escape", `Symlink "${input.path}" points outside the workspace`, input.tool, 403);
    }
  }
}

/** Minimal glob matcher: `*`, `**`, `?`, character classes and `!` negation, no external dependency. */
export function matchGlob(pattern: string, value: string): boolean {
  const negated = pattern.startsWith("!");
  const body = negated ? pattern.slice(1) : pattern;
  const target = value.replace(/\\/g, "/");
  const expression = globToRegExp(body);
  const matched = expression.test(target);
  // A bare pattern such as "*.ts" should also match nested files, like ripgrep's --glob does.
  const deep = body.includes("/") ? matched : expression.test(target.split("/").pop() ?? target);
  return negated ? !matched && !deep : matched || deep;
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      const isDouble = pattern[index + 1] === "*";
      if (isDouble) {
        const followedBySlash = pattern[index + 2] === "/";
        out += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") { out += "[^/]"; continue; }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index) {
        out += pattern.slice(index, end + 1);
        index = end;
        continue;
      }
    }
    out += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`);
}
