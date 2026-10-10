/** Real Docker invariant drill. Uses only owned random diagnostic scopes. */
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
const api = JSON.parse(docker(["inspect", "npati-agent-api"]))[0];
const secret = api.Config.Env.find(value => value.startsWith("NPATI_SANDBOX_RUNNER_SECRET=")).slice("NPATI_SANDBOX_RUNNER_SECRET=".length);
const endpoint = "http://127.0.0.1:7865";
const projects = [], evidence = [];
const containers = () => docker(["ps", "--format", "{{.Names}}"]).split("\n").filter(Boolean).sort();
const baseline = containers();
assert.equal(baseline.filter(name => name === "npati-project-runtime").length, 1);
assert.equal(baseline.some(name => /^npati-(sb|proxy)-/.test(name)), false, "Remove only known retired diagnostic workloads before recording baseline");
function count(label) {
  const names = containers(); assert.deepEqual(names, baseline, `Container set changed at ${label}`);
  evidence.push({ label, count: names.length, containers: names }); console.log(`${label}: ${names.length} containers`);
}
async function request(operation, payload = {}, expected = 200, route = "/v1/sandbox") {
  const body = JSON.stringify(route === "/v1/sandbox" ? { operation, payload } : {});
  const timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
  const response = await fetch(endpoint + route, { method: "POST", headers: { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature }, body, signal: AbortSignal.timeout(120_000) });
  const data = await response.json(); assert.equal(response.status, expected, `${operation}: ${data.error?.code ?? ""}`); return route === "/v1/sandbox" ? data.result : data;
}
const options = { timeoutMs: 15_000, outputLimitBytes: 64000 };
async function page(project) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const result = await request("proxyPreview", { ...project, options: { port: project.port, path: "/", method: "GET", headers: {} } });
      if (result.status === 200) return Buffer.from(result.body, "base64").toString();
    } catch { /* bounded startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("Project preview did not start");
}
try {
  const ready = await request("readiness", {}, 200, "/v1/readiness");
  assert.equal(ready.details.runtimeMode, "shared"); assert.equal(ready.overall_ready, true);
  count("baseline");
  for (const label of ["site", "blog", "CRM", "mobile", "E"]) {
    const scope = { workspaceId: "shared-regression-diagnostic", userId: "diagnostic", companyId: randomUUID(), projectId: randomUUID() };
    const created = await request("createSandbox", { scope });
    const project = { scope, sandboxId: created.id, label }; projects.push(project);
    await request("startSandbox", project);
    project.port = (await request("exposePort", { ...project, port: 3000 })).port;
    await request("uploadFiles", { ...project, files: [{ path: "server.cjs", content: `require('http').createServer((q,r)=>r.end('${label}')).listen(Number(process.env.PORT),'127.0.0.1');` }] });
    const result = await request("executeCommand", { ...project, command: "pwd", options });
    assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), `/projects/${scope.projectId}`);
    assert.equal((await request("createSandbox", { scope })).id, created.id);
    project.processId = (await request("startProcess", { ...project, command: "node server.cjs", options })).processId;
    assert.equal(await page(project), label); count(`project ${label} + command + preview`);
  }
  assert.equal(new Set(projects.map(project => project.port)).size, 5);
  for (const project of projects) assert.equal(await page(project), project.label);
  const project = projects[0], processId = randomUUID();
  const job = { ...project, command: "printf 'tracked-shared-job'", options: { ...options, processId } };
  const started = await request("startProcess", job); assert.equal(started.processId, processId);
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await request("getProcessStatus", { ...project, processId });
    if (status.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status.status, "completed"); assert.equal(status.exitCode, 0);
  assert.equal((await request("startProcess", job)).status, "completed");
  assert.equal((await request("getProcessOutput", { ...project, processId })).output, "tracked-shared-job");
  await request("startProcess", { ...job, command: "printf changed" }, 409);
  const noisyId = randomUUID();
  await request("startProcess", { ...project, command: `node -e 'process.stdout.write("Ї".repeat(70000));process.exit(7)'`, options: { ...options, processId: noisyId } });
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await request("getProcessStatus", { ...project, processId: noisyId });
    if (status.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status.status, "failed"); assert.equal(status.exitCode, 7);
  const output = await request("getProcessOutput", { ...project, processId: noisyId });
  assert.equal(output.nextOffset, 70000); assert.equal(output.earliestOffset, 6000); assert.equal(output.output.length, 64000);
  const cancelledId = randomUUID();
  await request("stopProcess", { ...project, processId: cancelledId });
  assert.equal((await request("startProcess", { ...project, command: "printf should-not-run", options: { ...options, processId: cancelledId } })).status, "stopped");
  count("tracked background job + same-id replay");
  // Reconnect with the existing scope/identity, then restart only API, not runtime.
  assert.equal((await request("getStatus", project)).id, project.sandboxId); count("reconnect");
  docker(["restart", "npati-agent-api"]);
  for (const item of projects) assert.equal(await page(item), item.label);
  assert.equal((await request("createSandbox", { scope: project.scope })).id, project.sandboxId);
  count("API restart + resume same identities + previews");
  await request("destroySandbox", project); projects.shift();
  for (const item of projects) assert.equal(await page(item), item.label);
  count("delete A leaves B/C/D/E running");
  console.log("Real shared runtime lifecycle invariant passed");
} finally {
  for (const project of projects) await request("destroySandbox", project);
  count("diagnostic cleanup leaves shared runtime running");
  writeFileSync("artifacts/shared-runtime-container-count.json", JSON.stringify({ baseline, evidence }, null, 2) + "\n");
}
