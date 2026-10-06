import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_FILE_URL_SITES,
  ProjectFilesClientError,
  assertProjectFilePath,
  projectFilesBase,
  withParam,
  workspaceSuffix,
} from "../apps/web/src/project-files-paths";

/**
 * C7 security-gate: the shared project-files adapter.
 *
 * What this suite pins, and why each part matters:
 *  - **One place builds a `files/*` URL.** The code workspace used to hand-copy a Website Builder route, so a
 *    change there would have broken it silently. A source scan over `apps/web/src` fails on any hand-built
 *    `files/tree|read|search|write` outside the adapter unless it is explicitly listed in
 *    `LEGACY_FILE_URL_SITES` with a reason — and a *stale* entry (the file no longer contains one) fails too, so
 *    the exemption list cannot rot into a blanket permission.
 *  - **Path validation happens before any request.** `..`, absolute, drive-letter, home-relative and backslash
 *    paths are refused with a typed error. This is defence in depth for fast feedback, not the security
 *    boundary: the server's `ProjectWorkspace` still enforces it, and the suite asserts the client never
 *    rewrites a path — what it accepts it passes through unchanged.
 *  - **Ids and paths are always encoded**, so a project id or a filename cannot smuggle a query parameter or a
 *    path segment into the URL.
 *
 * This suite deliberately imports only `project-files-paths.ts` (which has no imports of its own) and reads
 * files, so the security gate can run it in a plain Node environment. The transport half — bearer header,
 * error envelope, write body — is covered by
 * `apps/web/src/code-workspace/__tests__/project-files-client.test.ts`, which needs the bundler's resolution and
 * therefore lives with the web suites rather than in the gate.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCOPE = { companyId: "company-1", projectId: "project-1" };

describe("C7 [security-gate]: shared project-files adapter", () => {
  it("builds the same file surface the Website Builder workspace uses", () => {
    expect(projectFilesBase(SCOPE)).toBe("/api/companies/company-1/projects/project-1/files");
    expect(`${projectFilesBase(SCOPE)}/tree`).toBe("/api/companies/company-1/projects/project-1/files/tree");
    expect(withParam(`${projectFilesBase(SCOPE)}/read`, "path", "src/index.ts")).toBe(
      "/api/companies/company-1/projects/project-1/files/read?path=src%2Findex.ts",
    );
    expect(workspaceSuffix({ ...SCOPE, workspaceId: "ws 1" })).toBe("?workspaceId=ws%201");
    expect(withParam(`${projectFilesBase(SCOPE)}/read${workspaceSuffix({ ...SCOPE, workspaceId: "ws1" })}`, "path", "a b.ts")).toBe(
      "/api/companies/company-1/projects/project-1/files/read?workspaceId=ws1&path=a%20b.ts",
    );
  });

  it("encodes ids so they cannot smuggle an extra path segment or query parameter", () => {
    const hostileScope = { companyId: "company/../other", projectId: "p?x=1&y=2" };
    const base = projectFilesBase(hostileScope);
    expect(base).toBe("/api/companies/company%2F..%2Fother/projects/p%3Fx%3D1%26y%3D2/files");

    // The encoded id may contain the characters `..`, but it must never become a path segment of its own, and
    // it must not change how many segments the URL has — otherwise a hostile id could climb out of the project.
    expect(base.split("/")).not.toContain("..");
    expect(base.indexOf("?")).toBe(-1);
    expect(base.split("/").length).toBe(projectFilesBase(SCOPE).split("/").length);
    expect(decodeURIComponent(base).split("/").length).toBeGreaterThan(base.split("/").length);
  });

  it("refuses an incomplete scope before building a URL", () => {
    expect(() => projectFilesBase({ companyId: "", projectId: "p" })).toThrow(ProjectFilesClientError);
    expect(() => projectFilesBase({ companyId: "c", projectId: "" })).toThrow(/project id is required/i);
  });

  it("refuses traversal and absolute paths", () => {
    const hostile = ["../etc/passwd", "src/../../etc/passwd", "/etc/passwd", "\\windows\\system32", "C:/windows/system32", "~/.ssh/id_rsa", "src\\sum.ts", ""];
    for (const candidate of hostile) {
      expect(() => assertProjectFilePath(candidate), candidate).toThrow(ProjectFilesClientError);
    }
  });

  it("accepts ordinary project-relative paths unchanged (no rewriting)", () => {
    for (const good of ["src/index.ts", "package.json", "src/nested/deep/file.tsx", "a-b_c.d.ts"]) {
      expect(assertProjectFilePath(good)).toBe(good);
    }
    expect(assertProjectFilePath("src/./sum.ts")).toBe("src/./sum.ts");
  });
});

describe("C7 [security-gate]: only the adapter may build a files URL", () => {
  const FILE_URL_PATTERN = /files\/(tree|read|search|write)/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        walk(full, out);
        continue;
      }
      if (/\.(tsx?|jsx?)$/.test(entry) && !/\.(test|spec)\./.test(entry)) out.push(full);
    }
    return out;
  }

  it("finds file URLs only in the adapter or in an explicitly justified legacy site", () => {
    const files = walk(join(ROOT, "apps", "web", "src"));
    expect(files.length).toBeGreaterThan(20);

    const adapterFiles = new Set(["apps/web/src/project-files-client.ts", "apps/web/src/project-files-paths.ts"]);
    const legacyFiles = new Set(LEGACY_FILE_URL_SITES.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of files) {
      const relPath = relative(ROOT, file).split(sep).join("/");
      if (adapterFiles.has(relPath)) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (!FILE_URL_PATTERN.test(line)) return;
        if (legacyFiles.has(relPath)) return;
        offenders.push(`${relPath}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }

    expect(offenders, `hand-built files URLs must move to apps/web/src/project-files-client.ts:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps the legacy exemption list honest: a stale entry is a failure", () => {
    for (const entry of LEGACY_FILE_URL_SITES) {
      const source = readFileSync(join(ROOT, entry.file), "utf8");
      expect(FILE_URL_PATTERN.test(source), `${entry.file} no longer needs its exemption: ${entry.reason}`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("has both migrated pages going through the adapter", () => {
    for (const page of ["apps/web/src/CodeWorkspacePage.tsx", "apps/web/src/ProjectPage.tsx"]) {
      const source = readFileSync(join(ROOT, page), "utf8");
      expect(source, `${page} must import the shared adapter`).toContain("./project-files-client");
      expect(FILE_URL_PATTERN.test(source), `${page} must not build its own files URL`).toBe(false);
    }
    const dashboard = readFileSync(join(ROOT, "apps", "web", "src", "WebsiteBuilderDashboard.tsx"), "utf8");
    expect(dashboard).toContain("/settings/code/");
  });
});
