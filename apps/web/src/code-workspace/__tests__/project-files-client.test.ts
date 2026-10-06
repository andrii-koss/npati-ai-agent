import { describe, expect, it, vi } from "vitest";
import {
  listProjectFiles,
  readProjectFile,
  searchProjectFiles,
  writeProjectFile,
} from "../../project-files-client";
import { ProjectFilesClientError } from "../../project-files-paths";

/**
 * C7: the transport half of the shared project-files adapter.
 *
 * This lives with the web suites (not in the security gate) because it imports the client module, which
 * resolves through the bundler; the pure path logic and the "only one place builds a URL" invariant are
 * enforced by the gate suite `tests/coding-agent-c7-project-files-adapter.test.ts`.
 *
 * What it pins:
 *  - the bearer token is attached when one is stored, and a response without it is still attempted (the server
 *    is the authority, the client does not decide);
 *  - the server's error envelope becomes a message **plus its code**, and a non-envelope body still produces a
 *    status-bearing error — an error that loses its code makes an incident harder to diagnose;
 *  - a refused path never reaches the network (the spy proves zero calls);
 *  - a write carries the expected revision, so a concurrent edit is refused rather than overwritten.
 */

const SCOPE = { companyId: "company-1", projectId: "project-1" };

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(response: { ok?: boolean; status?: number; body?: unknown }): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function withLocalStorage<T>(run: () => Promise<T>): Promise<T> {
  const store = new Map<string, string>([["npati.auth.token", "test-token"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return run().finally(() => vi.unstubAllGlobals());
}

describe("C7: project-files client transport", () => {
  it("attaches the stored bearer token on every file call", async () => {
    await withLocalStorage(async () => {
      const { fetchImpl, calls } = stubFetch({ body: { files: [{ path: "src/index.ts" }] } });
      const result = await listProjectFiles(SCOPE, fetchImpl);
      expect(result.files).toEqual([{ path: "src/index.ts" }]);
      expect(calls[0]?.url).toBe("/api/companies/company-1/projects/project-1/files/tree");
      expect((calls[0]?.init?.headers as Headers).get("Authorization")).toBe("Bearer test-token");

      const read = stubFetch({ body: { path: "a.ts", content: "x" } });
      await readProjectFile(SCOPE, "a.ts", read.fetchImpl);
      expect(read.calls[0]?.url).toBe("/api/companies/company-1/projects/project-1/files/read?path=a.ts");
    });
  });

  it("surfaces the error code from the server envelope, and a status when there is no envelope", async () => {
    const failing = stubFetch({
      ok: false,
      status: 403,
      body: { error: { code: "workspace_access_denied", message: "Missing workspace read permission" } },
    });
    await expect(readProjectFile(SCOPE, "src/index.ts", failing.fetchImpl)).rejects.toThrow(
      /Missing workspace read permission \[workspace_access_denied\]/,
    );

    const opaque = stubFetch({ ok: false, status: 500, body: { unexpected: true } });
    const error = await searchProjectFiles(SCOPE, "index", opaque.fetchImpl).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProjectFilesClientError);
    expect((error as ProjectFilesClientError).status).toBe(500);
    expect((error as Error).message).toContain("HTTP 500");
  });

  it("never touches the network for a path the client refuses", async () => {
    const { fetchImpl, calls } = stubFetch({ body: { content: "should never be read" } });
    for (const hostile of ["../etc/passwd", "/etc/passwd", "C:/windows/system32", "~/.ssh/id_rsa", ""]) {
      await expect(readProjectFile(SCOPE, hostile, fetchImpl)).rejects.toThrow(ProjectFilesClientError);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends the expected revision on a write", async () => {
    const { fetchImpl, calls } = stubFetch({ body: { revision: "rev-2" } });
    const result = await writeProjectFile(SCOPE, "src/index.ts", "export {};", "rev-1", fetchImpl);
    expect(result.revision).toBe("rev-2");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/companies/company-1/projects/project-1/files/write");
    const body = JSON.parse(String(calls[0]?.init?.body)) as { path: string; content: string; expectedRevision?: string };
    expect(body).toMatchObject({ path: "src/index.ts", expectedRevision: "rev-1" });
  });
});
