import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Syntax check for a JavaScript file the agent has just written, reported in the write result. Without it the agent
 * spent a whole turn on `node --check` in the sandbox after every write (E2E G1: about 3.5 s of a 36 s run). The file
 * is only parsed, never run: `node --check` on a private temporary copy in the API process.
 */
const SCRIPT = /\.(?:m?js|cjs)$/i;
const MAX_BYTES = 512 * 1024;

export async function javascriptSyntax(filePath: string, content: string): Promise<{ ok: true } | { ok: false; error: string } | undefined> {
  if (!SCRIPT.test(filePath) || typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) return undefined;
  // The extension decides CommonJS or module, as it does for node itself; a plain .js with import/export is a module.
  const extension = /\.cjs$/i.test(filePath) ? ".cjs" : /\.mjs$/i.test(filePath) || /^\s*(?:import|export)\s/m.test(content) ? ".mjs" : ".js";
  const temporary = path.join(tmpdir(), `npati-syntax-${randomUUID()}${extension}`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    return await new Promise((resolve) => {
      execFile(process.execPath, ["--check", temporary], { timeout: 5_000, env: {} }, (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: true });
        if (error.killed) return resolve(undefined);
        // Point at the agent's file, not the temporary copy; keep only the line, the caret and the error.
        const text = String(stderr ?? "").split(temporary).join(filePath).split("\n").filter((line) => line.trim() && !/^\s+at |^Node\.js v/.test(line)).slice(0, 6).join("\n");
        resolve({ ok: false, error: text.slice(0, 800) || "SyntaxError" });
      });
    });
  } catch {
    return undefined;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
