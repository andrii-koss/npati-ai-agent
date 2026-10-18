#!/usr/bin/env node
/** Real Linux canonical Workspace/Git regression; uses an existing local Node-capable image only. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";

const image = process.argv[process.argv.indexOf("--image") + 1];
if (!process.argv.includes("--image") || !image || image.startsWith("-")) throw new Error("--image must select an existing local Node-capable test image");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "artifacts/c3-workspace-check.json";
if (!output || output.startsWith("-")) throw new Error("--output requires an artifact path");
const artifact = path.resolve(output);
if (!artifact.startsWith(path.resolve("artifacts") + path.sep)) throw new Error("Output must stay within artifacts");
const directory = path.resolve("artifacts", "workspace-posix-" + randomUUID());
const name = "npati-audit-posix-" + randomUUID();
fs.mkdirSync(directory, { recursive: true });
let started = false;
try {
  buildSync({ entryPoints: ["tests/support/c3-workspace-proof-entry.ts"], outfile: path.join(directory, "case.cjs"),
    bundle: true, platform: "node", format: "cjs", target: "node24", loader: { ".sql": "text" } });

  const inspected = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 15000 });
  if (inspected.status !== 0 || !/^sha256:[a-f0-9]{64}\s*$/.test(inspected.stdout)) throw new Error("The selected image is not available locally");
  const imageId = inspected.stdout.trim();
  started = true;
  const result = spawnSync("docker", ["run", "--rm", "--pull", "never", "--name", name,
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "10001:10001", "--memory", "256m", "--cpus", "1", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001",
    "--mount", "type=bind,src=" + directory + ",dst=/audit,readonly",
    "--entrypoint", "node", imageId, "/audit/case.cjs"], { encoding: "utf8", timeout: 60000 });
  let check = null;
  try { check = JSON.parse(result.stdout); } catch { /* An execution failure is retained as failure. */ }
  const report = { imageId, kind: "real-linux-file-operation-regression", imageAdmissionVerified: false,
    network: "none", status: result.status, passed: result.status === 0 && check?.passed === true, check,
    stderr: result.stderr, error: result.error?.message };
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally {
  if (started) {
    // The exact UUID name belongs exclusively to this test, including timeout cleanup.
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", timeout: 15000 });
  }
  const artifactRoot = path.resolve("artifacts") + path.sep;
  if (!directory.startsWith(artifactRoot)) throw new Error("Refusing cleanup outside artifacts");
  fs.rmSync(directory, { recursive: true, force: true });
}
