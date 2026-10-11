/** Run inside agent-api. Creates only temporary project workspaces, not containers. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

const base = process.env.NPATI_SANDBOX_RUNNER_URL ?? 'http://sandbox-runner:7865';
const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
assert(secret?.length >= 32, 'Runner secret is required');
const projects = [];
async function request(path, input) {
  const body = JSON.stringify(input), timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  const response = await fetch(base + path, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-npati-timestamp': timestamp, 'x-npati-nonce': nonce, 'x-npati-signature': signature },
    signal: AbortSignal.timeout(180000) });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
}
async function operation(project, operation, payload = {}) {
  return (await request('/v1/sandbox', { operation, payload: { scope: project.scope, sandboxId: project.id, ...payload } })).result;
}
async function execute(project, command) {
  const result = await operation(project, 'executeCommand', { command, options: { timeoutMs: 120000, outputLimitBytes: 32000 } });
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
try {
  const ready = await request('/v1/readiness', {});
  assert.equal(ready.overall_ready, true);
  assert.equal(ready.details.runtimeMode, 'shared');
  assert.equal(ready.details.dockerRequired, false);
  assert.match(ready.details.isolation, /^namespaces:/);
  for (let i = 0; i < 2; i++) {
    const project = { scope: { workspaceId: randomUUID(), userId: randomUUID(), companyId: randomUUID(), projectId: randomUUID() } };
    project.id = (await operation(project, 'createSandbox')).id;
    projects.push(project);
    await operation(project, 'startSandbox');
    project.port = (await operation(project, 'exposePort', { port: 3001 })).port;
  }
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i], other = projects[1 - i];
    const files = [
      { path: 'index.html', content: `SITE_${i}_BEFORE` },
      { path: 'package.json', content: JSON.stringify({ name: 'npati-runtime-probe', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' } }) },
      { path: 'site.cjs', content: "require('node:http').createServer((q,r)=>r.end(require('node:fs').readFileSync('index.html'))).listen(Number(process.env.PORT),'127.0.0.1');" },
      { path: 'edit.cjs', content: `require('node:fs').writeFileSync('index.html','SITE_${i}_AGENT_EDITED'); require('node:fs').writeFileSync(process.env.HOME+'/persistent-marker','present');` },
      { path: 'check.cjs', content: `const assert=require('node:assert/strict'),fs=require('node:fs'); assert.equal(fs.readFileSync(process.env.HOME+'/persistent-marker','utf8'),'present'); for(const path of ['/projects/${other.scope.projectId}/index.html','/runtime-state/projects.json','/var/run/docker.sock']){assert.throws(()=>fs.readFileSync(path));} assert.equal(require('is-number')(123),true); assert.notEqual(require('node:child_process').spawnSync('unshare',['-Ur','true']).status,0); console.log('FILES_ISOLATED_AND_DEPENDENCIES_READY');` },
      { path: 'network.cjs', content: `const assert=require('node:assert/strict'); (async()=>{assert.equal((await fetch('http://10.0.2.2:${project.port}/',{signal:AbortSignal.timeout(3000)})).status,200); for(const url of ['http://10.0.2.2:${other.port}/','http://10.0.2.2:7865/health','http://1.1.1.1/']){await assert.rejects(fetch(url,{signal:AbortSignal.timeout(2000)}));} console.log('NETWORK_ISOLATED');})().catch(e=>{console.error(e);process.exit(1)});` },
    ];
    await operation(project, 'uploadFiles', { files });
    await execute(project, 'node edit.cjs');
    const downloaded = await operation(project, 'downloadFiles');
    assert.equal(downloaded.find(file => file.path === 'index.html')?.content, `SITE_${i}_AGENT_EDITED`);
    await execute(project, 'npm install');
    await execute(project, 'node check.cjs');
    await operation(project, 'startProcess', { command: 'node /workspace/site.cjs', options: { cwd: '.', timeoutMs: 60000, outputLimitBytes: 64000 } });
  }
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    let response;
    for (let retry = 0; retry < 20; retry++) {
      try { response = await operation(project, 'proxyPreview', { options: { port: project.port, path: '/', method: 'GET', headers: {} } }); break; }
      catch (error) { if (retry === 19) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
    }
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(response.body, 'base64').toString(), `SITE_${i}_AGENT_EDITED`);
    await execute(project, 'node network.cjs');
    const job = await operation(project, 'startProcess', { command: 'node edit.cjs', options: { cwd: '.', timeoutMs: 60000, outputLimitBytes: 64000 } });
    let status;
    for (let retry = 0; retry < 30; retry++) {
      status = await operation(project, 'getProcessStatus', { processId: job.processId });
      if (status.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(status.exitCode, 0, 'Async edit must coexist with preview');
    const afterJob = await operation(project, 'proxyPreview', { options: { port: project.port, path: '/', method: 'GET', headers: {} } });
    assert.equal(afterJob.status, 200);
  }
  console.log(JSON.stringify({ passed: true, isolation: ready.details.isolation, fileEditing: true, persistentHome: true,
    npmInstall: true, crossProjectFilesDenied: true, crossProjectNetworkDenied: true, previews: projects.map(p => ({ port: p.port, status: 200 })) }, null, 2));
} finally {
  for (const project of projects) await operation(project, 'destroySandbox').catch(error => console.error(`Probe cleanup failed: ${error.message}`));
}
