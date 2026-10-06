/**
 * Shared project-files client adapter (C7).
 *
 * Why this module exists: before C7, four pages hand-built `files/*` URLs (`ProjectPage`, `WebsiteEditor`,
 * `BusinessWorkspace`, `CodeWorkspacePage`). That meant the Code Workspace depended on a route shape it had
 * copied by hand, so a change to the Website Builder file surface would have broken the code workspace
 * silently. Pages now ask this module for a tree or a file; only `project-files-paths.ts` knows the shape.
 *
 * Relationship to the server (the honest version): a browser SPA has exactly one transport — HTTP — so a
 * shared *browser* service object cannot bypass the route. What matters is that the route is not a parallel
 * implementation: `project-file-routes.ts` holds no file logic, it authorizes the caller and delegates to the
 * `ProjectWorkspace` service, which is the same service the Website Builder editor, chat attachments and the
 * code tool runtime use. So there is one implementation of project files (`ProjectWorkspace`) and one client
 * entry point (this module); the route is a thin transport shim over the service, not a second source of truth.
 *
 * Every response body is treated as data: callers render file content, names and paths as text nodes.
 */

import { getStoredAuthToken } from "./AuthContext";
import {
  ProjectFilesClientError,
  assertProjectFilePath,
  assertScope,
  projectFilesBase,
  withParam,
  workspaceSuffix,
  type ProjectFileContent,
  type ProjectFileEntry,
  type ProjectFilesScope,
} from "./project-files-paths";

export {
  LEGACY_FILE_URL_SITES,
  ProjectFilesClientError,
  assertProjectFilePath,
  projectFilesBase,
  type ProjectFileContent,
  type ProjectFileEntry,
  type ProjectFilesScope,
} from "./project-files-paths";

function authHeaders(): Headers {
  const headers = new Headers();
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string; code?: string } };
    const code = data?.error?.code ? ` [${data.error.code}]` : "";
    if (data?.error?.message) return `${data.error.message}${code}`;
  } catch {
    /* the body was not the error envelope */
  }
  return `HTTP ${response.status}`;
}

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new ProjectFilesClientError("project_files_request_failed", await readError(response), response.status);
  }
  return (await response.json()) as T;
}

/** File tree for a project. Same route the Website Builder workspace uses, via one adapter. */
export async function listProjectFiles(
  scope: ProjectFilesScope,
  fetchImpl: typeof fetch = fetch,
): Promise<{ files: ProjectFileEntry[]; workspace?: unknown }> {
  assertScope(scope);
  const data = await getJson<{ files?: ProjectFileEntry[]; workspace?: unknown }>(
    `${projectFilesBase(scope)}/tree${workspaceSuffix(scope)}`,
    fetchImpl,
  );
  return { files: data.files ?? [], workspace: data.workspace };
}

/** One file's content (`{ path, content, size, revision }`). */
export async function readProjectFile(
  scope: ProjectFilesScope,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectFileContent> {
  assertScope(scope);
  const safePath = assertProjectFilePath(path);
  return getJson<ProjectFileContent>(
    withParam(`${projectFilesBase(scope)}/read${workspaceSuffix(scope)}`, "path", safePath),
    fetchImpl,
  );
}

/** Filename search within a project. */
export async function searchProjectFiles(
  scope: ProjectFilesScope,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectFileEntry[]> {
  assertScope(scope);
  const data = await getJson<{ files?: ProjectFileEntry[] }>(
    withParam(`${projectFilesBase(scope)}/search${workspaceSuffix(scope)}`, "query", query ?? ""),
    fetchImpl,
  );
  return data.files ?? [];
}

/** Write with an expected revision, so a concurrent edit is refused rather than overwritten. */
export async function writeProjectFile(
  scope: ProjectFilesScope,
  path: string,
  content: string,
  expectedRevision?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ revision?: string }> {
  assertScope(scope);
  const safePath = assertProjectFilePath(path);
  const headers = authHeaders();
  headers.set("Content-Type", "application/json");
  const response = await fetchImpl(`${projectFilesBase(scope)}/write`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: safePath, content, expectedRevision }),
  });
  if (!response.ok) {
    throw new ProjectFilesClientError("project_files_request_failed", await readError(response), response.status);
  }
  return (await response.json()) as { revision?: string };
}
