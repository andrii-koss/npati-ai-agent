/**
 * Project-files path layer (C7).
 *
 * The pure half of the shared adapter: no React, no `fetch`, no auth — just the one place where a
 * `files/*` URL is assembled and the client-side path guard. Keeping it dependency-free means the security
 * gate can test it in a plain Node environment (the render-level suites need a DOM and stay outside the
 * gate), and it means a page cannot accidentally re-derive the route shape.
 */

export type ProjectFileEntry = {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  revision?: string;
  children?: ProjectFileEntry[];
};

export type ProjectFileContent = {
  path: string;
  content: string;
  size?: number;
  revision?: string;
};

export type ProjectFilesScope = {
  companyId: string;
  projectId: string;
  /** Optional Website Builder workspace override; the server route accepts it for every file operation. */
  workspaceId?: string;
};

export class ProjectFilesClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProjectFilesClientError";
  }
}

/**
 * Files in `apps/web/src` that still build `files/*` URLs by hand, with the reason each was not migrated.
 *
 * A source scan (`tests/coding-agent-c7-project-files-adapter.test.ts`) fails on any `files/tree|read|search|write`
 * occurrence outside the adapter unless it is listed here — so a new hand-built URL is a test failure, and a
 * stale entry (the file no longer contains one) is a failure too.
 */
export const LEGACY_FILE_URL_SITES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "apps/web/src/WebsiteEditor.tsx",
    reason:
      "The page builder (4126 lines) is deliberately untouched by C7; migrating its five file call sites is a separate change with its own Website Builder regression run.",
  },
  {
    file: "apps/web/src/business-workspace-cards.tsx",
    reason:
      "Chat static-preview reader, carried over from BusinessWorkspace.tsx when the file was split into shared state, cards and page views. Still a legacy site awaiting migration to the adapter, with the same scope as before the split.",
  },
  {
    file: "apps/web/src/website-editor-drawers.tsx",
    reason:
      "Website editor file drawer reader, carried over from WebsiteEditor.tsx when the drawers were extracted. Still a legacy site awaiting migration to the adapter, with the same scope as before the split.",
  },
];

/** The single place a `files/*` path is assembled. */
export function projectFilesBase(scope: ProjectFilesScope): string {
  assertScope(scope);
  return `/api/companies/${encodeURIComponent(scope.companyId)}/projects/${encodeURIComponent(scope.projectId)}/files`;
}

/** `?`-prefixed workspace override, or an empty string — so appending `&path=…` is always correct. */
export function workspaceSuffix(scope: ProjectFilesScope): string {
  return scope.workspaceId ? `?workspaceId=${encodeURIComponent(scope.workspaceId)}` : "";
}

/** Appends `key=value` to a path that may or may not already carry a workspace override. */
export function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

export function assertScope(scope: ProjectFilesScope): void {
  if (!scope?.companyId) throw new ProjectFilesClientError("company_id_required", "A company id is required");
  if (!scope?.projectId) throw new ProjectFilesClientError("project_id_required", "A project id is required");
}

/**
 * A path that cannot be inside any workspace, refused before a request is made.
 *
 * This is a **client-side** guard for fast feedback only. The security boundary is the server's
 * `ProjectWorkspace` (`assertSafeWorkspacePath`); nothing here weakens or replaces it.
 */
export function assertProjectFilePath(path: string): string {
  const value = typeof path === "string" ? path : "";
  if (value.trim().length === 0) throw new ProjectFilesClientError("invalid_path", "File path is required");
  if (value.startsWith("/") || value.startsWith("\\")) {
    throw new ProjectFilesClientError("invalid_path", "Absolute paths are not project-relative");
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    throw new ProjectFilesClientError("invalid_path", "Drive-letter paths are not project-relative");
  }
  if (value.startsWith("~")) throw new ProjectFilesClientError("invalid_path", "Home-relative paths are not project-relative");
  if (value.includes("\\")) throw new ProjectFilesClientError("invalid_path", "Backslashes are not valid in a project path");
  if (value.split("/").some((segment) => segment === "..")) {
    throw new ProjectFilesClientError("invalid_path", "Path traversal segments are not allowed");
  }
  return value;
}
