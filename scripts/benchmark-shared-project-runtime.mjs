/** Pipe into node inside agent-api. Uses a temporary project; never creates containers. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const base = process.env.NPATI_SANDBOX_RUNNER_URL ?? 'http://sandbox-runner:7865';
const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
assert(secret?.length >= 32, 'Runner secret is required');
async function request(path, input) {
  const body = JSON.stringify(input), timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  const response = await fetch(base + path, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-npati-timestamp': timestamp, 'x-npati-nonce': nonce, 'x-npati-signature': signature },
    signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
}
const scope = Object.fromEntries(['workspaceId', 'userId', 'companyId', 'projectId'].map(key => [key, randomUUID()]));
let sandboxId;
async function operation(operation, payload = {}) {
  // Match RemoteSandboxProvider: authenticated readiness before every operation.
  const ready = await request('/v1/readiness', {});
  assert.equal(ready.overall_ready, true);
  assert.equal(ready.details.runtimeMode, 'shared');
  return (await request('/v1/sandbox', { operation, payload: { scope, sandboxId, ...payload } })).result;
}
async function measure(name, action) {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now(); await action(); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { name, medianMs: Math.round((samples[4] + samples[5]) / 2), p90Ms: Math.round(samples[8]), samples: 10 };
}
try {
  sandboxId = (await operation('createSandbox')).id;
  await operation('startSandbox');
  const files = [{ path: 'probe.cjs', content: "require('node:fs').writeFileSync('result.txt','edited');" }];
  await operation('uploadFiles', { files });
  // Expire the short proof cache; report full verification separately from warm access.
  await new Promise(resolve => setTimeout(resolve, 2200));
  const coldStart = performance.now();
  assert.equal((await request('/v1/readiness', {})).overall_ready, true);
  const expiredCacheReadinessMs = Math.round(performance.now() - coldStart);
  const results = [];
  results.push(await measure('readiness', async () => assert.equal((await request('/v1/readiness', {})).overall_ready, true)));
  results.push(await measure('statusWithReadiness', () => operation('getStatus')));
  results.push(await measure('editWithReadiness', async () => {
    const result = await operation('executeCommand', { command: 'node probe.cjs', options: { timeoutMs: 10000, outputLimitBytes: 64000 } });
    assert.equal(result.exitCode, 0, result.stderr);
  }));
  results.push(await measure('syncEditSyncWithReadiness', async () => {
    await operation('uploadFiles', { files });
    const result = await operation('executeCommand', { command: 'node probe.cjs', options: { timeoutMs: 10000, outputLimitBytes: 64000 } });
    assert.equal(result.exitCode, 0, result.stderr);
    const downloaded = await operation('downloadFiles');
    assert.equal(downloaded.find(file => file.path === 'result.txt')?.content, 'edited');
  }));
  console.log(JSON.stringify({ expiredCacheReadinessMs, results }, null, 2));
} finally {
  if (sandboxId) await operation('destroySandbox');
}
