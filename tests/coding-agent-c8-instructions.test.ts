import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_FILE_NAMES,
  MAX_INSTRUCTION_FILE_CHARS,
  PROJECT_INSTRUCTIONS_SCHEMA_VERSION,
  UNTRUSTED_INSTRUCTIONS_HEADER,
  buildProjectInstructions,
  projectInstructionsContentHash,
  selectInstructionFiles,
} from "../apps/agent-api/src/code-project-instructions";
import { createCodeInstructionsLoader } from "../apps/agent-api/src/code-instructions-loader";
import type { AuthContext } from "@npati/workspace";

/**
 * C8 — the project instruction file (`NPATI.md`), its hierarchy, its limits and its hash.
 *
 * The properties worth pinning are the ones that decide what the model is allowed to see: a deterministic
 * hierarchy, one shared list of file names (no third convention), bounded size with an honest truncation
 * marker, and a content hash that moves when — and only when — the effective instructions move.
 */

const ctx = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:read"] } as unknown as AuthContext;

function files(entries: Record<string, string>) {
  return Object.entries(entries).map(([path, content]) => ({ path, content }));
}

describe("[C8] [security-gate] project instruction hierarchy", () => {
  it("reads one shared list of names and never invents a third convention", () => {
    expect(Array.from(INSTRUCTION_FILE_NAMES)).toEqual(["NPATI.md", "AGENTS.md", "PROJECT.md"]);
  });

  it("applies root files always and subdirectory files only along the path of the work", () => {
    const selected = selectInstructionFiles({
      files: files({
        "NPATI.md": "root",
        "src/NPATI.md": "in src",
        "docs/NPATI.md": "in docs",
      }),
      targetPaths: ["src/index.ts"],
    });
    expect(selected.map((file) => file.path)).toEqual(["NPATI.md", "src/NPATI.md"]);
    // `docs/` is not on the way to `src/index.ts`, so its file cannot inject itself into this run.
    expect(selected.some((file) => file.path.startsWith("docs/"))).toBe(false);
  });

  it("orders the hierarchy deterministically: user, project, then directory scopes by depth", () => {
    const selected = selectInstructionFiles({
      files: files({
        "AGENTS.md": "agents",
        "NPATI.md": "project",
        "a/b/NPATI.md": "deep",
        "a/NPATI.md": "shallow",
      }),
      targetPaths: ["a/b/file.ts"],
    });
    expect(selected.map((file) => file.path)).toEqual(["NPATI.md", "AGENTS.md", "a/NPATI.md", "a/b/NPATI.md"]);
  });

  it("gives NPATI.md precedence over AGENTS.md and the shared PROJECT.md in the same directory", () => {
    const built = buildProjectInstructions({
      files: files({ "PROJECT.md": "shared", "AGENTS.md": "compat", "NPATI.md": "own" }),
      trusted: true,
    });
    expect(built.applied.map((file) => file.path)).toEqual(["NPATI.md", "AGENTS.md", "PROJECT.md"]);
    // All three are applied, in that order, so the project's own file is read first and can override the rest.
    expect(built.body.indexOf("own")).toBeLessThan(built.body.indexOf("compat"));
    expect(built.body.indexOf("compat")).toBeLessThan(built.body.indexOf("shared"));
  });

  it("marks truncation explicitly and caps a single file", () => {
    const built = buildProjectInstructions({
      files: files({ "NPATI.md": "x".repeat(MAX_INSTRUCTION_FILE_CHARS + 500) }),
      trusted: true,
    });
    expect(built.truncated).toBe(true);
    expect(built.applied[0]!.truncated).toBe(true);
    expect(built.body).toContain("[truncated");
  });

  it("is stable: the same tree produces byte-identical bytes and the same hash", () => {
    const input = { files: files({ "NPATI.md": "rules", "AGENTS.md": "compat" }), trusted: true };
    expect(buildProjectInstructions(input).body).toBe(buildProjectInstructions(input).body);
    expect(buildProjectInstructions(input).contentHash).toBe(buildProjectInstructions(input).contentHash);
  });
});

describe("[C8] [security-gate] instruction content hash", () => {
  it("moves when the instructions change", () => {
    const before = buildProjectInstructions({ files: files({ "NPATI.md": "use tabs" }), trusted: true });
    const after = buildProjectInstructions({ files: files({ "NPATI.md": "use spaces" }), trusted: true });
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("does not move when nothing effective changes", () => {
    const a = buildProjectInstructions({ files: files({ "NPATI.md": "same" }), trusted: true });
    const b = buildProjectInstructions({ files: files({ "NPATI.md": "same" }), trusted: true });
    expect(a.contentHash).toBe(b.contentHash);
    // Changing trust *does* change what the model is told, so it changes the hash as well.
    const untrusted = buildProjectInstructions({ files: files({ "NPATI.md": "same" }), trusted: false });
    expect(untrusted.contentHash).not.toBe(a.contentHash);
  });

  it("reports null when the run had no instructions at all", () => {
    const empty = buildProjectInstructions({ files: [], trusted: false });
    expect(empty.applied).toEqual([]);
    expect(projectInstructionsContentHash(empty)).toBeNull();
  });

  it("declares the schema version so a persisted hash can be interpreted later", () => {
    expect(buildProjectInstructions({ files: [], trusted: false }).schemaVersion).toBe(PROJECT_INSTRUCTIONS_SCHEMA_VERSION);
  });
});

describe("[C8] [security-gate] instruction secrets and loading", () => {
  it("excludes a file that contains a credential instead of silently redacting it", () => {
    const built = buildProjectInstructions({
      files: files({ "NPATI.md": `deploy with ghp_${"a".repeat(36)}` }),
      trusted: true,
    });
    expect(built.applied).toEqual([]);
    expect(built.excluded.map((file) => file.path)).toEqual(["NPATI.md"]);
    expect(built.excluded[0]!.reason).toBe("secret_detected");
    // The credential never reaches the prompt block.
    expect(built.body).not.toContain("ghp_");
    expect(built.body).toBe("");
  });

  it("loads through the injected reader and treats an unreadable file as absent", async () => {
    const loader = createCodeInstructionsLoader({
      readFile: async ({ path }) => {
        if (path === "NPATI.md") return "root rules";
        if (path === "src/NPATI.md") throw new Error("no such file");
        return null;
      },
      isTrusted: async () => false,
    });
    const loaded = await loader.load({ ctx, companyId: "company-a", projectId: "project-1", targetPaths: ["src/a.ts"] });
    expect(loaded.applied.map((file) => file.path)).toEqual(["NPATI.md"]);
    expect(loaded.header).toBe(UNTRUSTED_INSTRUCTIONS_HEADER);
  });

  it("fails closed on trust: a throwing trust lookup means untrusted", async () => {
    const loader = createCodeInstructionsLoader({
      readFile: async () => "rules",
      isTrusted: async () => {
        throw new Error("store unavailable");
      },
    });
    const loaded = await loader.load({ ctx, companyId: "company-a", projectId: "project-1" });
    expect(loaded.trusted).toBe(false);
    expect(loaded.header).toBe(UNTRUSTED_INSTRUCTIONS_HEADER);
  });

  it("keeps tenants apart: another project's files are simply not read", async () => {
    const loader = createCodeInstructionsLoader({
      readFile: async ({ projectId, path }) => (projectId === "project-1" && path === "NPATI.md" ? "project one" : null),
      isTrusted: async ({ projectId }) => projectId === "project-1",
    });
    const mine = await loader.load({ ctx, companyId: "company-a", projectId: "project-1" });
    const foreign = await loader.load({ ctx, companyId: "company-a", projectId: "project-2" });
    expect(mine.body).toContain("project one");
    expect(foreign.body).toBe("");
    expect(foreign.applied).toEqual([]);
  });
});
