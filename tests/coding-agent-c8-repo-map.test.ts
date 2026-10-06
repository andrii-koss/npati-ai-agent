import { describe, expect, it } from "vitest";

import type { AuthContext, ProjectFileEntry } from "../packages/workspace/src/types";
import {
  RepoMapSecretRejectedError,
  buildRepoMap,
  createRepoMapCache,
  estimateRepoMapTokens,
  extractRepoMapSymbols,
  isNoiseRepoPath,
  isSecretRepoPath,
  repoMapLanguageFor,
  resolveRepoMapLimits,
  type RepoMapFilePort,
  type RepoMapLimits,
} from "../apps/agent-api/src/code-repo-map";

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const WORKSPACE = "workspace-1";
const CTX = { userId: "user-1", companyId: COMPANY } as unknown as AuthContext;
/** A GitHub-shaped token the C4a scanner recognises; used only to prove the refusal path. */
const CANARY_SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ENABLED: Partial<RepoMapLimits> = { enabled: true };

type FakeFile = { path: string; content: string; size?: number };

function fakePorts(files: FakeFile[], calls?: { list: number; read: string[] }): RepoMapFilePort {
  const entries: ProjectFileEntry[] = files.map((file) => ({
    path: file.path,
    name: file.path.split("/").pop() ?? file.path,
    type: "file",
    size: file.size ?? file.content.length,
    revision: "r1",
  }));
  return {
    listFiles: async (ctx, companyId) => {
      if (calls) calls.list += 1;
      // Tenant isolation at the port: another company simply has no such project.
      if (ctx !== CTX || companyId !== COMPANY) return [];
      return entries;
    },
    readFile: async (ctx, companyId, projectId, filePath) => {
      if (calls) calls.read.push(filePath);
      if (ctx !== CTX || companyId !== COMPANY) throw new Error("forbidden");
      const found = files.find((file) => file.path === filePath);
      if (!found) throw new Error(`missing ${filePath}`);
      return { path: filePath, content: found.content, size: found.content.length, revision: "r1" };
    },
  };
}

const TREE: FakeFile[] = [
  {
    path: "src/app.ts",
    content: [
      "export function startServer() { return 1; }",
      "export class Router {}",
      "function helper() {}",
      "const notASymbol = 3;",
    ].join("\n"),
  },
  {
    path: "src/deep/nested/util.ts",
    content: "export function deepUtil() {}",
  },
  {
    path: "scripts/run.py",
    content: "def main():\n    pass\n\nclass Runner:\n    pass",
  },
  {
    path: "node_modules/dep/index.ts",
    content: "export function fromDependency() {}",
  },
  {
    path: ".git/config",
    content: "export function fromGitDir() {}",
  },
  {
    path: "dist/bundle.js",
    content: "export function fromBuild() {}",
  },
  {
    path: "package-lock.json",
    content: '{"name":"x"}',
  },
  {
    path: ".env",
    content: `DATABASE_URL=postgres://user:${CANARY_SECRET}@host/db`,
  },
  {
    path: "certs/server.pem",
    content: "-----BEGIN PRIVATE KEY-----",
  },
];

function request(overrides: Record<string, unknown> = {}) {
  return {
    ctx: CTX,
    companyId: COMPANY,
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    commit: "commit-a",
    limits: ENABLED,
    ...overrides,
  } as Parameters<typeof buildRepoMap>[1];
}

describe("[C8] repo map: structure, ranking and token budget", () => {
  it("maps real symbols and excludes noise directories and lock files", async () => {
    const result = await buildRepoMap({ files: fakePorts(TREE) }, request({ tokenLimit: 900 }));
    expect(result.enabled).toBe(true);
    expect(result.text).toContain("src/app.ts");
    expect(result.text).toContain("startServer");
    expect(result.text).toContain("Router");
    expect(result.text).toContain("scripts/run.py");
    expect(result.text).toContain("main");
    // Noise must not reach the prompt at all — a dependency's internals are not project structure.
    expect(result.text).not.toContain("node_modules");
    expect(result.text).not.toContain("fromDependency");
    expect(result.text).not.toContain("fromGitDir");
    expect(result.text).not.toContain("fromBuild");
    expect(result.text).not.toContain("package-lock.json");
  });

  it("never emits file content, only paths and signatures", async () => {
    const result = await buildRepoMap(
      {
        files: fakePorts([
          { path: "src/x.ts", content: "export function x() {\n  const body = 'CONTENT_BODY';\n}" },
        ]),
      },
      request({ tokenLimit: 900 }),
    );
    expect(result.text).toContain("x");
    expect(result.text).not.toContain("CONTENT_BODY");
  });

  it("ranks task-relevant files first and is deterministic across runs", async () => {
    const files: FakeFile[] = [
      { path: "src/a.ts", content: "export function a() {}" },
      { path: "src/b.ts", content: "export function b() {}" },
    ];
    const first = await buildRepoMap({ files: fakePorts(files) }, request({ focusPaths: ["src/b.ts"] }));
    const second = await buildRepoMap({ files: fakePorts(files) }, request({ focusPaths: ["src/b.ts"] }));
    const firstLine = first.text.split("\n")[0]!;
    expect(firstLine).toContain("src/b.ts");
    expect(first.text).toEqual(second.text);
  });

  it("honours the token limit and marks truncation explicitly", async () => {
    const files: FakeFile[] = Array.from({ length: 60 }, (_, index) => ({
      path: `src/module-${String(index).padStart(3, "0")}.ts`,
      content: `export function fn${index}() {}`,
    }));
    const result = await buildRepoMap({ files: fakePorts(files) }, request({ tokenLimit: 120 }));
    expect(estimateRepoMapTokens(result.text)).toBeLessThanOrEqual(120 + 30);
    expect(result.truncated).toBe(true);
    expect(result.omittedFiles).toBeGreaterThan(0);
    // A silently shortened map is the failure mode this marker exists to prevent.
    expect(result.text).toContain("repo map truncated");
    expect(result.files).toBeLessThan(files.length);
  });

  it("is disabled by default and does nothing when the flag is off", async () => {
    const calls = { list: 0, read: [] as string[] };
    const result = await buildRepoMap(
      { files: fakePorts(TREE, calls) },
      request({ limits: { enabled: false } }),
    );
    expect(result.enabled).toBe(false);
    expect(result.text).toBe("");
    // Off means "no work", not "work then discard".
    expect(calls.list).toBe(0);
    expect(resolveRepoMapLimits({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });
});

describe("[C8] repo map: commit-keyed cache and invalidation", () => {
  it("reuses the cached map for the same commit and rebuilds for a new one", async () => {
    const cache = createRepoMapCache();
    const calls = { list: 0, read: [] as string[] };
    const ports = { files: fakePorts(TREE, calls), cache };

    const first = await buildRepoMap(ports, request({ commit: "commit-a" }));
    expect(first.cacheHit).toBe(false);
    // Listing must run on every call: the content fingerprint that keeps the map from going stale is
    // derived from it. The *reads* are the expensive part, and those are what the cache must skip.
    const readsAfterFirst = calls.read.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = await buildRepoMap(ports, request({ commit: "commit-a" }));
    expect(second.cacheHit).toBe(true);
    expect(second.text).toEqual(first.text);
    expect(calls.read.length).toBe(readsAfterFirst);

    const third = await buildRepoMap(ports, request({ commit: "commit-b" }));
    expect(third.cacheHit).toBe(false);
    expect(calls.read.length).toBeGreaterThan(readsAfterFirst);
  });

  it("does not serve one company's map to another", async () => {
    const cache = createRepoMapCache();
    const result = await buildRepoMap(
      { files: fakePorts(TREE), cache },
      request({ commit: "commit-a" }),
    );
    expect(result.enabled).toBe(true);

    const otherRequest = request({
      commit: "commit-a",
      companyId: OTHER_COMPANY,
      ctx: { userId: "user-2", companyId: OTHER_COMPANY } as unknown as AuthContext,
    });
    const other = await buildRepoMap({ files: fakePorts(TREE), cache }, otherRequest);
    // The port returns nothing for the other tenant, so the result cannot be a cache hit.
    expect(other.cacheHit).toBe(false);
    expect(other.files).toBe(0);
  });

  it("changes the map after files change and the commit moves", async () => {
    const cache = createRepoMapCache();
    const before = await buildRepoMap(
      { files: fakePorts(TREE), cache },
      request({ commit: "commit-a" }),
    );
    const after = await buildRepoMap(
      {
        files: fakePorts([
          ...TREE,
          { path: "src/added.ts", content: "export function addedLater() {}" },
        ]),
        cache,
      },
      request({ commit: "commit-b" }),
    );
    expect(after.text).toContain("addedLater");
    expect(before.text).not.toContain("addedLater");
  });

  it("never serves a stale map when files change without a new commit", async () => {
    // A run edits the workspace long before it commits anything. A commit-only cache key would hand
    // the model the pre-edit map of the very file it just wrote — the stale-context failure this key
    // exists to prevent.
    const cache = createRepoMapCache();
    const before = await buildRepoMap(
      { files: fakePorts(TREE), cache },
      request({ commit: "commit-a" }),
    );
    const after = await buildRepoMap(
      {
        files: fakePorts([
          ...TREE.filter((file) => file.path !== "src/app.ts"),
          { path: "src/app.ts", content: "export function rewrittenAfterEdit() {}" },
        ]),
        cache,
      },
      request({ commit: "commit-a" }),
    );
    expect(after.cacheHit).toBe(false);
    expect(after.text).toContain("rewrittenAfterEdit");
    expect(after.text).not.toContain("startServer");
    expect(before.text).toContain("startServer");
  });

  it("produces a byte-identical map for the same content regardless of cache state", async () => {
    // The map becomes part of the model-visible context, hence part of the C6b replay input: a warm
    // cache must be an optimisation that returns the same bytes, never a second source of truth.
    const withFreshCache = await buildRepoMap(
      { files: fakePorts(TREE), cache: createRepoMapCache() },
      request({ commit: "commit-a" }),
    );
    const shared = createRepoMapCache();
    await buildRepoMap({ files: fakePorts(TREE), cache: shared }, request({ commit: "commit-a" }));
    const withWarmCache = await buildRepoMap(
      { files: fakePorts(TREE), cache: shared },
      request({ commit: "commit-a" }),
    );
    const withoutCache = await buildRepoMap(
      { files: fakePorts(TREE) },
      request({ commit: "commit-a" }),
    );
    expect(withWarmCache.cacheHit).toBe(true);
    expect(withFreshCache.text).toEqual(withoutCache.text);
    expect(withWarmCache.text).toEqual(withoutCache.text);
    expect(withWarmCache.tokens).toEqual(withoutCache.tokens);
  });
});

describe("[C8] repo map: secret handling", () => {
  it("never names secret files in the map", async () => {
    const result = await buildRepoMap({ files: fakePorts(TREE) }, request({ tokenLimit: 900 }));
    expect(result.text).not.toContain(".env");
    expect(result.text).not.toContain("server.pem");
    expect(result.skippedSecrets).toBeGreaterThanOrEqual(2);
    expect(isSecretRepoPath(".env")).toBe(true);
    expect(isSecretRepoPath("certs/server.pem")).toBe(true);
    expect(isSecretRepoPath("src/app.ts")).toBe(false);
  });

  it("refuses the whole map when a secret-shaped value reaches the rendered text", async () => {
    const ports: RepoMapFilePort = {
      listFiles: async () => [
        {
          path: "src/leak.ts",
          name: "leak.ts",
          type: "file",
          size: 10,
          revision: "r1",
        },
      ],
      readFile: async (_ctx, _companyId, _projectId, filePath) => ({
        path: filePath,
        // A secret inside a *declaration line*, which is exactly where a signature is taken from.
        content: `export const token = "${CANARY_SECRET}";`,
        size: 80,
        revision: "r1",
      }),
    };
    await expect(buildRepoMap({ files: ports }, request())).rejects.toBeInstanceOf(
      RepoMapSecretRejectedError,
    );
  });

  it("ignores a focus path that points at a secret", async () => {
    const result = await buildRepoMap(
      { files: fakePorts(TREE) },
      request({ focusPaths: [".env"] }),
    );
    expect(result.text).not.toContain(".env");
  });
});

describe("[C8] repo map: helpers", () => {
  it("classifies noise paths with the sandbox's own exclusion list", () => {
    expect(isNoiseRepoPath("node_modules/x/y.ts")).toBe(true);
    expect(isNoiseRepoPath(".git/HEAD")).toBe(true);
    expect(isNoiseRepoPath("dist/app.js")).toBe(true);
    expect(isNoiseRepoPath("src/app.ts")).toBe(false);
  });

  it("detects symbols per language and skips unsupported files", () => {
    expect(repoMapLanguageFor("a/b.ts")).toBe("ts");
    expect(repoMapLanguageFor("a/b.py")).toBe("python");
    expect(repoMapLanguageFor("a/README.md")).toBeNull();
    const symbols = extractRepoMapSymbols({
      path: "x.ts",
      language: "ts",
      content: "export function alpha() {}\nclass Beta {}\nconst gamma = 1;",
      maxSignatureChars: 160,
    });
    expect(symbols.map((symbol) => symbol.name)).toEqual(["alpha", "Beta"]);
    expect(symbols[0]!.exported).toBe(true);
    expect(extractRepoMapSymbols({ path: "x.md", language: "md", content: "# x", maxSignatureChars: 80 })).toEqual([]);
  });

  it("treats an oversized file as name-only instead of reading it", async () => {
    const calls = { list: 0, read: [] as string[] };
    const result = await buildRepoMap(
      { files: fakePorts([{ path: "src/huge.ts", content: "x", size: 5_000_000 }], calls) },
      request(),
    );
    expect(result.text).toContain("body skipped");
    expect(calls.read).toEqual([]);
  });
});
