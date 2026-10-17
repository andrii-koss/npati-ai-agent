import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/** Executes the real CLI control flow against a disposable catalog and a declared, simulated external-tool port. */
export function runImageScriptFixture(script: string, scenario: string, overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "npati-image-script-"));
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("npati-image-script-"))
    throw new Error("Unsafe fixture directory");
  try {
    mkdirSync(path.join(directory, "lib"));
    const catalogPath = path.join(directory, "images.json"), callsPath = path.join(directory, "calls.json");
    const reference = "ghcr.io/npati/node@sha256:" + "a".repeat(64);
    writeFileSync(catalogPath, JSON.stringify({ registry: "ghcr.io/npati", images: [{
      id: "node", variant: "node", reference, digest: "sha256:" + "a".repeat(64), status: "unverified",
      sbomPath: "fixture.spdx.json", signature: { identity: "ci@npati", issuer: "https://issuer" },
      scan: { tool: "trivy", critical: 0, high: 0, at: new Date().toISOString() }, ...overrides,
    }] }));
    writeFileSync(callsPath, "[]");
    const original = path.resolve("scripts/sandbox-image-lib.mjs");
    const stub = [
      "export * from " + JSON.stringify(pathToFileURL(original).href) + ";",
      "import fs from 'node:fs';",
      "export const commandExists = () => true;",
      "export const requireTool = () => true;",
      "export function runTool(command, args) {",
      "const file = " + JSON.stringify(callsPath) + ";const calls=JSON.parse(fs.readFileSync(file,'utf8'));calls.push([command,...args]);fs.writeFileSync(file,JSON.stringify(calls));",
      "const scenario = " + JSON.stringify(scenario) + ";",
      "if(command==='trivy')return {ok:scenario!=='scan-exit',unavailable:false,code:scenario==='scan-exit'?1:0,stderr:'scanner diagnostic',stdout:scenario==='scan-malformed'?'{}':JSON.stringify({Results:[]})};",
      "if(command==='cosign')return {ok:true,code:0,stdout:'verified',stderr:''};",
      "if(command==='docker'&&args[0]==='buildx')return calls.length===1?{ok:true,stdout:'sha256:'+'b'.repeat(64)}:{ok:false,code:1,stdout:'',stderr:'base digest unavailable'};",
      "return {ok:true,code:0,stdout:'',stderr:''};}",
    ].join("\n");
    writeFileSync(path.join(directory, "sandbox-image-lib.mjs"), stub);
    writeFileSync(path.join(directory, "lib/sandbox-image-scan-policy.mjs"), readFileSync("scripts/lib/sandbox-image-scan-policy.mjs"));
    const executable = path.join(directory, script);
    writeFileSync(executable, readFileSync(path.join("scripts", script)));
    const result = spawnSync(process.execPath, [executable, "--catalog", catalogPath, "--variant", "node", "--tool", "trivy"], {
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    if (result.error) throw result.error;
    return { code: result.status, output: result.stdout + result.stderr,
      entry: JSON.parse(readFileSync(catalogPath, "utf8")).images[0],
      calls: JSON.parse(readFileSync(callsPath, "utf8")) as string[][] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
