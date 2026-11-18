import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractProjectZip, type ImportedTextFile } from "../apps/agent-api/src/project-import-zip";
import { normalizeWorkspacePath } from "../apps/agent-api/src/code-tools-path";

/**
 * C14 red-team — zip-slip, Unicode/NUL spellings and long paths (G1 coverage item 2c: "архіви (zip-slip),
 * нормалізація unicode, null bytes, довгі шляхи").
 *
 * The extraction guard is not re-implemented here: `extractProjectZip` runs the real
 * `safeProjectPath` policy, and the workspace-relative guard (`normalizeWorkspacePath`) is the one the fs
 * tools use. What this suite adds is the *evidence* for the archive channel, which no security-gate suite
 * covered: `tests/project-import.test.ts` is outside the gate and checks four names with a bare `toThrow`.
 *
 * Asserted here:
 *  - traversal (`../`, `a/../../b`, `..`), absolute, UNC, drive-letter and backslash spellings are refused with
 *    the structured `unsafe_zip_path` code **before** any file is written;
 *  - NUL bytes, Windows reserved names, trailing dot/space, protected names, over-long names and too many
 *    segments are refused by the same guard;
 *  - every *accepted* entry resolves inside the workspace root — proved with `path.resolve`, not by pattern
 *    matching — including the encoded (`%2e%2e`, `..%2f`) and Unicode look-alike (`．．`, `․․`) spellings that
 *    the guard deliberately does not normalise;
 *  - the guard discriminates: a benign sibling archive extracts with exactly its own paths.
 *
 * Honest limits (see `security-gate/security-gate-report.md`): the extractor's duplicate detection is
 * **not** Unicode-normalised, so two spellings of one name (NFC and NFD) are accepted as two entries; and the
 * `path.resolve` containment proof is a statement about the guard's output, not about a real filesystem write.
 */

/** Minimal store-method ZIP writer, identical in shape to the one `tests/project-import.test.ts` uses. */
function zip(files: Array<{ path: string; content: string; method?: 0 | 8; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const directories: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const data = Buffer.from(file.content);
    const compressed = file.method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.method ?? 0, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(file.method ?? 0, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    directories.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/** The workspace root stand-in. Nothing below may resolve outside it. */
const WORKSPACE_ROOT = path.resolve("C:/npati/workspaces/project-c14");

/** True when a workspace-relative path really resolves inside the workspace root. */
function resolvesInsideWorkspace(relative: string): boolean {
  const root = path.resolve(WORKSPACE_ROOT);
  const candidate = path.resolve(root, relative);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** The structured refusal code for one archive, or `null` when the archive was accepted. */
function refusalFor(entryPath: string): string | null {
  try {
    extractProjectZip(zip([{ path: entryPath, content: "payload" }]));
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown_error";
  }
}

/** Names that must never produce a writable entry. */
const HOSTILE_ARCHIVE_NAMES: readonly string[] = [
  "../outside.txt",
  "../../outside.txt",
  "a/../../b.txt",
  "folder/../../outside.txt",
  "..",
  "/absolute.txt",
  "//server/share.txt",
  "C:\\Windows\\win.ini",
  "..\\..\\outside.txt",
  "src\\..\\..\\outside.txt",
  "nul\u0000.txt",
  "CON",
  "aux.txt",
  "trailing.",
  "trailing ",
  ".git/config",
  ".env",
  "id_rsa",
  `${Array.from({ length: 33 }, (_, index) => `d${index}`).join("/")}/deep.txt`,
  `${"a".repeat(1100)}.txt`,
];

/**
 * Names the guard accepts as **literal single path segments**. Each one is a classic traversal bypass
 * attempt, and each one is harmless precisely because the guard refuses to decode or normalise it.
 */
const ENCODED_AND_UNICODE_NAMES: readonly string[] = [
  "..%2f..%2foutside.txt",
  "%2e%2e%2foutside.txt",
  "．．/outside.txt",
  "․․/outside.txt",
];

describe("security-gate: C14 red-team — zip-slip, Unicode, NUL and long paths", () => {
  it("refuses zip-slip: traversal, absolute, UNC, drive-letter and backslash entry names never extract", () => {
    const traversal = ["../outside.txt", "../../outside.txt", "a/../../b.txt", "folder/../../outside.txt", ".."];
    const escapes = ["/absolute.txt", "//server/share.txt", "C:\\Windows\\win.ini", "..\\..\\outside.txt", "src\\..\\..\\outside.txt"];
    for (const name of [...traversal, ...escapes]) {
      expect(refusalFor(name), `name ${JSON.stringify(name)}`).toBe("unsafe_zip_path");
    }
    // The refusal is not a blanket "every archive fails": the benign sibling below extracts.
    expect(refusalFor("src/index.ts")).toBe(null);
  });

  it("refuses NUL bytes, Windows reserved names, trailing dot/space, protected names and over-long names", () => {
    for (const name of ["nul\u0000.txt", "CON", "aux.txt", "trailing.", "trailing "]) {
      expect(refusalFor(name), `name ${JSON.stringify(name)}`).toBe("unsafe_zip_path");
    }
    // Protected files are refused by the same call, with the same structured code for the archive caller.
    for (const name of [".git/config", ".env", "id_rsa"]) {
      expect(refusalFor(name), `name ${JSON.stringify(name)}`).toBe("unsafe_zip_path");
    }
    // A fullwidth dot followed by an ASCII dot ends the segment with a dot, which the guard refuses: the
    // Unicode spelling is refused for the *same* reason as `trailing.`, not by a special Unicode rule.
    expect(refusalFor("．./outside.txt")).toBe("unsafe_zip_path");
    // Length and segment-count ceilings, so a long path cannot be used to exhaust or confuse the writer.
    expect(refusalFor(`${"a".repeat(1100)}.txt`)).toBe("unsafe_zip_path");
    expect(refusalFor(`${Array.from({ length: 33 }, (_, index) => `d${index}`).join("/")}/deep.txt`)).toBe("unsafe_zip_path");
    // A symlink entry is refused too, so an archive cannot install a link and then write through it.
    let symlinkCode: string | null = null;
    try {
      extractProjectZip(zip([{ path: "link", content: "target", mode: 0xa000 }]));
    } catch (error) {
      symlinkCode = (error as { code?: string }).code ?? "unknown_error";
    }
    expect(symlinkCode).toBe("unsupported_zip");
  });

  it("negative control: a benign archive extracts with exactly its own paths, and every accepted path resolves inside the workspace", () => {
    const entries = extractProjectZip(zip([
      { path: "src/index.ts", content: "export const ready = true;\n" },
      { path: "docs/guide.md", content: "# Guide\n" },
      { path: "package.json", content: "{}" },
    ]));
    expect(entries.map((entry: ImportedTextFile) => entry.path)).toEqual(["src/index.ts", "docs/guide.md", "package.json"]);
    for (const entry of entries) {
      expect(resolvesInsideWorkspace(entry.path), `path ${entry.path}`).toBe(true);
    }
    // The containment predicate is discriminating, not "true for everything": a real traversal fails it.
    expect(resolvesInsideWorkspace("../../outside.txt")).toBe(false);
    expect(resolvesInsideWorkspace("/absolute.txt")).toBe(false);
  });

  it("keeps encoded and Unicode look-alike traversal attempts inside the workspace (the guard decodes nothing)", () => {
    for (const name of ENCODED_AND_UNICODE_NAMES) {
      const entries = extractProjectZip(zip([{ path: name, content: "payload" }]));
      expect(entries.length > 0, `name ${JSON.stringify(name)}`).toBe(true);
      for (const entry of entries) {
        // Whatever the guard decided the path is, it is a plain relative path that cannot leave the root:
        // `%2f`/`%2e` and the fullwidth/one-dot-leader spellings are *data*, never a separator or a `..`.
        expect(resolvesInsideWorkspace(entry.path), `name ${JSON.stringify(name)} -> ${entry.path}`).toBe(true);
        expect(entry.path.split("/").includes("..")).toBe(false);
      }
    }
    // …which is the honest statement of the property: no decoding, therefore no bypass. The workspace-relative
    // guard the fs tools use behaves the same way for the same spellings.
    expect(normalizeWorkspacePath("..%2f..%2foutside.txt", { tool: "code.fs.read" })).toBe("..%2f..%2foutside.txt");
    expect(normalizeWorkspacePath("．．/outside.txt", { tool: "code.fs.read" })).toBe("．．/outside.txt");
  });

  it("records the measured Unicode-normalisation gap instead of claiming it is covered", () => {
    const nfc: string = "caf\u00e9.txt";
    const nfd: string = "cafe\u0301.txt";
    expect(nfc === nfd).toBe(false);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    const entries = extractProjectZip(zip([{ path: nfc, content: "one" }, { path: nfd, content: "two" }]));
    // The property this test *requires* (and that stays true if the extractor is hardened later): nothing
    // escapes, and every accepted name is the name that was archived.
    for (const entry of entries) {
      expect(resolvesInsideWorkspace(entry.path)).toBe(true);
      expect(entry.path.normalize("NFC")).toBe(nfc);
    }
    // Measured today and recorded as a known limitation in the security-gate report: the duplicate-path check
    // is not Unicode-normalised, so on a normalisation-insensitive filesystem these two entries name one file.
    expect(entries.length >= 1).toBe(true);
    expect(entries.every((entry) => entry.path.normalize("NFC") === nfc)).toBe(true);
  });

  it("refuses the same separator and length spellings at the workspace-relative path guard", () => {
    // Spellings the read-tool suite does not cover: backslash traversal, collapsed duplicate separators,
    // `..` behind a leading segment, and the length ceiling of the guard itself.
    for (const candidate of ["..\\..\\etc\\passwd", "a//../b", "nested/./../../x", "src/../x"]) {
      let code: string | null = null;
      try {
        normalizeWorkspacePath(candidate, { tool: "code.fs.read" });
      } catch (error) {
        code = (error as { code?: string }).code ?? "unknown_error";
      }
      expect(code, `candidate ${JSON.stringify(candidate)}`).toBe("path_outside_workspace");
    }
    let tooLong: string | null = null;
    try {
      normalizeWorkspacePath("a/".repeat(3_000), { tool: "code.fs.read" });
    } catch (error) {
      tooLong = (error as { code?: string }).code ?? "unknown_error";
    }
    expect(tooLong).toBe("invalid_path");
    let nul: string | null = null;
    try {
      normalizeWorkspacePath("src/\u0000index.ts", { tool: "code.fs.read" });
    } catch (error) {
      nul = (error as { code?: string }).code ?? "unknown_error";
    }
    expect(nul).toBe("null_byte");
    // Positive control: the ordinary shapes are accepted, so the refusals above are about the spellings.
    expect(normalizeWorkspacePath("src/index.ts", { tool: "code.fs.read" })).toBe("src/index.ts");
    expect(normalizeWorkspacePath("src\\lib\\index.ts", { tool: "code.fs.read" })).toBe("src/lib/index.ts");
    expect(normalizeWorkspacePath("./src//lib/", { tool: "code.fs.list" })).toBe("src/lib");
  });

  it("negative control: both guards accept the ordinary shapes they exist to accept", () => {
    // The archive guard: an ordinary project archive extracts, with its own paths.
    const entries = extractProjectZip(zip([
      { path: "app/page.tsx", content: "export default function Page() { return null; }\n" },
      { path: "package.json", content: "{}" },
    ]));
    expect(entries.map((entry) => entry.path)).toEqual(["app/page.tsx", "package.json"]);
    expect(entries.every((entry) => resolvesInsideWorkspace(entry.path))).toBe(true);
    // The workspace-relative guard: ordinary relative shapes normalise instead of being refused.
    for (const candidate of ["src/index.ts", "docs/guide.md", "a/b/c/d.txt"]) {
      expect(normalizeWorkspacePath(candidate, { tool: "code.fs.read" }), `candidate ${candidate}`).toBe(candidate);
    }
    // …and the guards are not "accept everything": the same calls refuse the hostile spellings.
    expect(refusalFor("../outside.txt")).toBe("unsafe_zip_path");
    let refusal: string | null = null;
    try {
      normalizeWorkspacePath("../outside.txt", { tool: "code.fs.read" });
    } catch (error) {
      refusal = (error as { code?: string }).code ?? "unknown_error";
    }
    expect(refusal).toBe("path_outside_workspace");
  });
});
