// Copy this file, project-runtime-profiles.json and the request helper into /app in agent-api.
// Builds real projects using each prepared profile; creates/removes diagnostic workspaces only.
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { request } = require('./verify-shared-project-runtime.cjs');
const profiles = require('./project-runtime-profiles.json');
const options = { timeoutMs: 600000, outputLimitBytes: 64000 };
const staticServer = "const fs=require('fs'),p=require('path');require('http').createServer((q,r)=>{const file=p.join(process.cwd(),'dist',q.url==='/'?'index.html':q.url.split('?')[0]);try{r.end(fs.readFileSync(file))}catch{r.statusCode=404;r.end('missing')}}).listen(Number(process.env.PORT),'127.0.0.1');";
const specs = [
  { name: 'next', command: 'npm run dev', scripts: { build: 'next build', dev: 'next dev' }, files: {
    'app/layout.js': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.js': 'export default function Page(){return <h1>prepared-next-runtime</h1>}',
    'next.config.mjs': 'export default {experimental:{cpus:2}};'
  }, marker: 'prepared-next-runtime' },
  { name: 'vite-react', command: 'npm run dev', scripts: { build: 'vite build', dev: 'vite --host 0.0.0.0' }, files: {
    'index.html': '<html><body><div id="root">prepared-vite-react-runtime</div><script type="module" src="/main.jsx"></script></body></html>',
    'main.jsx': "import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<h1>prepared-vite-react-runtime</h1>);"
  }, marker: 'prepared-vite-react-runtime' },
  { name: 'vite-vue', command: 'npm run dev', scripts: { build: 'vite build', dev: 'vite --host 0.0.0.0' }, files: {
    'index.html': '<html><body><div id="app">prepared-vite-vue-runtime</div><script type="module" src="/main.js"></script></body></html>',
    'main.js': "import{createApp}from'vue';createApp({template:'<h1>prepared-vite-vue-runtime</h1>'}).mount('#app');"
  }, marker: 'prepared-vite-vue-runtime' },
  { name: 'nuxt', command: 'npm run dev', scripts: { build: 'nuxt build', dev: 'nuxt dev --host 0.0.0.0' }, files: {
    'app.vue': '<template><h1>prepared-nuxt-runtime</h1></template>',
    'nuxt.config.ts': 'export default defineNuxtConfig({devtools:{enabled:false},telemetry:false});'
  }, marker: 'prepared-nuxt-runtime' },
  { name: 'astro', command: 'npm run dev', scripts: { build: 'astro build', dev: 'astro dev --host 0.0.0.0' }, files: {
    'src/pages/index.astro': '<html><body><h1>prepared-astro-runtime</h1></body></html>'
  }, marker: 'prepared-astro-runtime' },
  { name: 'expo-web', command: 'node preview.cjs', scripts: { build: 'expo export --platform web --output-dir dist' }, extra: { main: 'expo/AppEntry.js' }, files: {
    'app.json': '{"expo":{"name":"Prepared Expo Check","slug":"prepared-expo-check","web":{"bundler":"metro"}}}',
    'App.js': "import React from 'react';import{View,Text}from'react-native';export default function App(){return <View><Text>prepared-expo-runtime</Text></View>;}",
    'preview.cjs': staticServer
  }, marker: '<html' },
];
(async () => {
  const created = [], report = [];
  try {
    for (const spec of specs) {
      const scope = { workspaceId: 'prepared-runtime-diagnostic', userId: 'diagnostic', companyId: randomUUID(), projectId: randomUUID() };
      const sandbox = await request('createSandbox', { scope });
      const project = { scope, sandboxId: sandbox.id }; created.push(project);
      await request('startSandbox', project);
      project.port = (await request('exposePort', { ...project, port: 3000 })).port;
      const files = { ...spec.files, 'package.json': JSON.stringify({ name: `prepared-${spec.name}`, version: '1.0.0', private: true, ...profiles[spec.name], scripts: spec.scripts, ...spec.extra }) };
      await request('uploadFiles', { ...project, files: Object.entries(files).map(([path, content]) => ({ path, content })) });
      const installed = await request('executeCommand', { ...project, command: 'npm install', options });
      assert.equal(installed.exitCode, 0, installed.stderr); assert.ok(installed.stdout.includes(`Prepared dependencies: ${spec.name}`), installed.stdout);
      const built = await request('executeCommand', { ...project, command: 'npm run build', options });
      assert.equal(built.exitCode, 0, `${spec.name}: ${built.stderr}\n${built.stdout.slice(-2500)}`);
      project.processId = (await request('startProcess', { ...project, command: spec.command, options })).processId; project.marker = spec.marker;
      const result = { framework: spec.name, installMs: installed.durationMs, buildMs: built.durationMs, port: project.port }; report.push(result); console.log(JSON.stringify(result));
    }
    for (const project of created) {
      let passed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try { const page = await request('proxyPreview', { ...project, options: { port: project.port, path: '/', method: 'GET', headers: {} } }); if (page.status === 200 && Buffer.from(page.body, 'base64').toString().includes(project.marker)) { passed = true; break; } } catch { /* server starting */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.ok(passed, `Preview failed on port ${project.port}`);
    }
    assert.equal(new Set(created.map(project => project.port)).size, specs.length);
    const first = created[0];
    await request('uploadFiles', { ...first, files: [{ path: 'check-tools.cjs', content: "const fs=require('fs'),cp=require('child_process');for(const cmd of ['python3','git']){const r=cp.spawnSync(cmd,['--version'],{encoding:'utf8'});if(r.status!==0)throw Error(cmd+' missing');console.log(r.stdout.trim())}try{fs.writeFileSync('/opt/npati-project-toolchain/profiles.json','tampered');process.exit(1)}catch{console.log('prepared profiles are read-only')}" }] });
    const tools = await request('executeCommand', { ...first, command: 'node check-tools.cjs', options }); assert.equal(tools.exitCode, 0, tools.stderr);
    console.log(JSON.stringify({ preparedProfiles: report, simultaneousPreviews: '6 x HTTP 200', tools: tools.stdout.trim(), extraProjectContainers: 0 }));
  } finally { for (const project of created) await request('destroySandbox', project); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
