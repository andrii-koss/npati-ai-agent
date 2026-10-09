/* Run inside agent-api (Node receives the existing runner secret via env):
 * Get-Content -Raw scripts/verify-shared-project-runtime.cjs | docker exec -i npati-agent-api node
 * Creates and removes only random diagnostic workspaces; never uses user projects. */
const { createHmac, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const endpoint = process.env.NPATI_SANDBOX_RUNNER_URL || 'http://sandbox-runner:7865';
async function request(operation, payload, expected = 200) {
  const body = JSON.stringify({ operation, payload }), timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac('sha256', process.env.NPATI_SANDBOX_RUNNER_SECRET).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  const response = await fetch(`${endpoint}/v1/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-npati-timestamp': timestamp, 'x-npati-nonce': nonce, 'x-npati-signature': signature }, body, signal: AbortSignal.timeout((payload.options?.timeoutMs || 105000) + 15000) });
  const data = await response.json();
  assert.equal(response.status, expected, `${operation}: ${data.error?.code || ''} ${data.error?.message || ''}`);
  return data.result;
}
const options = { timeoutMs: 15000, outputLimitBytes: 64000 };
async function preview(project) {
  return request('proxyPreview', { ...project, options: { port: project.port, path: '/', method: 'GET', headers: {} } });
}
async function waitPreview(project) {
  for (let index = 0; index < 30; index++) {
    try { const result = await preview(project); if (result.status === 200) return JSON.parse(Buffer.from(result.body, 'base64').toString()); } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Preview did not start');
}
async function runDiagnostics() {
  const projects = [];
  try {
    for (const label of ['A', 'B']) {
      const scope = { workspaceId: 'shared-runtime-diagnostic', userId: 'diagnostic', companyId: randomUUID(), projectId: randomUUID() };
      const sandbox = await request('createSandbox', { scope });
      const project = { scope, sandboxId: sandbox.id, label }; projects.push(project);
      await request('startSandbox', project);
      project.port = (await request('exposePort', { ...project, port: 3000 })).port;
      const source = `const http=require('http');console.log('project-${label}-started');http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({project:'${label}',public:process.env.PROJECT_PUBLISHABLE_KEY,supervisorSecret:!!process.env.NPATI_SANDBOX_RUNNER_SECRET,cwd:process.cwd()}))}).listen(Number(process.env.PORT),'127.0.0.1');`;
      project.source = source;
      await request('uploadFiles', { ...project, files: [{ path: 'server.cjs', content: source }, { path: 'own.txt', content: label }] });
      project.processId = (await request('startProcess', { ...project, command: 'node server.cjs', options: { ...options, environment: { PROJECT_PUBLISHABLE_KEY: label } } })).processId;
    }
    const [a, b] = projects;
    assert.notEqual(a.port, b.port);
    for (const project of projects) { const page = await waitPreview(project); assert.equal(page.project, project.label); assert.equal(page.public, project.label); assert.equal(page.supervisorSecret, false); assert.equal(page.cwd, `/projects/${project.scope.projectId}`); }
    await request('getStatus', { ...a, sandboxId: b.sandboxId }, 403);
    await request('getLogs', { ...a, processId: b.processId }, 404);
    await request('stopProcess', { ...a, processId: b.processId }, 404);
    await request('proxyPreview', { ...a, options: { port: b.port, path: '/', method: 'GET', headers: {} } }, 403);
    const probe = `const fs=require('fs'),net=require('net'),dns=require('dns');const target='/projects/${b.scope.projectId}/own.txt';for(const operation of [()=>fs.readFileSync(target),()=>fs.writeFileSync(target,'corrupt'),()=>fs.readFileSync('/proc/self/root'+target),()=>fs.readFileSync('/runtime-state/projects.json')]){try{operation();throw Error('Isolation bypass')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}}fs.symlinkSync(target,'escape');try{fs.readFileSync('escape');throw Error('Symlink bypass')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}fs.unlinkSync('escape');const check=(host,port)=>new Promise((resolve,reject)=>{const s=net.connect(port,host);s.on('connect',()=>{s.destroy();reject(Error('Network bypass'))});s.on('error',()=>resolve());s.setTimeout(1500,()=>{s.destroy();resolve()})});Promise.all([check('127.0.0.1',${b.port}),check('1.1.1.1',443),check('1.1.1.1',8080),new Promise((resolve,reject)=>dns.resolve4('example.com',(err)=>err?resolve():reject(Error('DNS bypass'))))]).then(()=>console.log('OS isolation passed'));`;
    await request('uploadFiles', { ...a, files: [{ path: 'probe.cjs', content: probe }] });
    const checked = await request('executeCommand', { ...a, command: 'node probe.cjs', options });
    assert.equal(checked.exitCode, 0, checked.stderr);
    assert.match(checked.stdout, /OS isolation passed/);
    // Writes through a project-created symlink also stay inside the OS boundary.
    await request('uploadFiles', { ...a, files: [{ path: 'symlink.cjs', content: `require('fs').symlinkSync('/projects/${b.scope.projectId}','foreign')` }] });
    assert.equal((await request('executeCommand', { ...a, command: 'node symlink.cjs', options })).exitCode, 0);
    await request('uploadFiles', { ...a, files: [{ path: 'foreign/own.txt', content: 'corrupt' }] }, 403);
    await request('stopProcess', b);
    assert.equal((await waitPreview(a)).project, 'A');
    assert.match(await request('getLogs', { ...a, processId: a.processId }), /project-A-started/);
    const files = await request('downloadFiles', b); assert.equal(files.find(file => file.path === 'own.txt').content, 'B');
    await request('uploadFiles', { ...b, files: [{ path: 'server.cjs', content: b.source }] });
    assert.equal((await request('downloadFiles', b)).some(file => file.path === 'own.txt'), false);
    b.processId = (await request('startProcess', { ...b, command: 'node /workspace/server.cjs', options: { ...options, environment: { PROJECT_PUBLISHABLE_KEY: 'B' } } })).processId;
    assert.equal((await waitPreview(b)).project, 'B');
    assert.equal((await waitPreview(a)).project, 'A');
    const alias = await request('executeCommand', { ...b, command: 'cat /workspace/server.cjs', options }); assert.equal(alias.stdout, b.source);
    console.log(JSON.stringify({ simultaneousProjects: 2, distinctPorts: true, contextGuards: true, filesystemAndSymlinkIsolation: true, networkAndDnsIsolation: true, separateEnvironmentAndLogs: true, stopAndRestartAreProjectScoped: true, sourceDeletionSync: true, legacyWorkspacePaths: true }));
  } finally { for (const project of projects) await request('destroySandbox', project); }
}
module.exports = { request, options };
if (!module.parent) runDiagnostics().catch(error => { console.error(error.message); process.exitCode = 1; });
