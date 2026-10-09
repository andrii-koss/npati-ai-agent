// Run with Node inside agent-api after copying this file and its helper to /tmp.
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { request } = require('./verify-shared-project-runtime.cjs');
const options = { timeoutMs: 600000, outputLimitBytes: 64000 };
const manifest = (name, dependencies, scripts, extra = {}) => JSON.stringify({ name, private: true, dependencies, scripts, ...extra });
const specs = [
  { name: 'next', command: 'npm run dev', files: {
    'package.json': manifest('runtime-next-check', { next: '14.2.35', react: '18.2.0', 'react-dom': '18.2.0' }, { build: 'next build', dev: 'next dev' }),
    'app/layout.js': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.js': 'export default function Page(){return <h1>shared-next-runtime</h1>}',
    'next.config.mjs': 'export default {experimental:{cpus:2}};'
  }, marker: 'shared-next-runtime' },
  { name: 'vite', command: 'npm run dev', files: {
    'package.json': manifest('runtime-vite-check', { vite: '^5.4.0', react: '18.2.0', 'react-dom': '18.2.0' }, { build: 'vite build', dev: 'vite --host 0.0.0.0' }),
    'index.html': '<html><body><div id="root">shared-vite-runtime</div><script type="module" src="/main.jsx"></script></body></html>',
    'main.jsx': "import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<h1>shared-vite-runtime</h1>);"
  }, marker: 'shared-vite-runtime' },
  { name: 'expo', command: 'npm run export && npx -y serve -s dist -l 3000', files: {
    'package.json': manifest('runtime-expo-check', { expo: '~51.0.39', '@expo/metro-runtime': '~3.2.3', react: '18.2.0', 'react-dom': '18.2.0', 'react-native': '0.74.5', 'react-native-web': '~0.19.10', serve: '14.2.4' }, { build: 'expo export --platform web --output-dir dist', export: 'expo export --platform web --output-dir dist' }, { main: 'expo/AppEntry.js' }),
    'app.json': '{"expo":{"name":"Runtime Expo Check","slug":"runtime-expo-check","web":{"bundler":"metro"}}}',
    'App.js': "import React from 'react';import{View,Text}from'react-native';export default function App(){return <View><Text>shared-expo-runtime</Text></View>}"
  }, marker: '<html' },
  { name: 'node', command: 'node server.cjs', files: {
    'package.json': manifest('runtime-node-check', {}, { build: 'node --check server.cjs', test: 'node --check server.cjs' }),
    'server.cjs': "require('http').createServer((q,r)=>r.end('shared-node-runtime')).listen(Number(process.env.PORT),'127.0.0.1');"
  }, marker: 'shared-node-runtime' },
];
(async () => {
  const created = [];
  try {
    for (const spec of specs) {
      const scope = { workspaceId: 'framework-runtime-diagnostic', userId: 'diagnostic', companyId: randomUUID(), projectId: randomUUID() };
      const sandbox = await request('createSandbox', { scope });
      const project = { scope, sandboxId: sandbox.id }; created.push(project);
      await request('startSandbox', project);
      const port = (await request('exposePort', { ...project, port: 3000 })).port;
      await request('uploadFiles', { ...project, files: Object.entries(spec.files).map(([path, content]) => ({ path, content })) });
      for (const command of ['npm install', 'npm run build']) {
        const result = await request('executeCommand', { ...project, command, options });
        assert.equal(result.exitCode, 0, `${spec.name} ${command}: ${result.stderr}\n${result.stdout.slice(-2500)}`);
      }
      const process = await request('startProcess', { ...project, command: spec.command, options });
      project.processId = process.processId; project.port = port; project.marker = spec.marker;
      console.log(JSON.stringify({ framework: spec.name, build: 'passed', port }));
    }
    for (const project of created) {
      let passed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const result = await request('proxyPreview', { ...project, options: { port: project.port, path: '/', method: 'GET', headers: {} } });
          if (result.status === 200 && Buffer.from(result.body, 'base64').toString().includes(project.marker)) { passed = true; break; }
        } catch { /* server/export starting */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!passed) console.log((await request('getLogs', project)).slice(-2000));
      assert.equal(passed, true, `Preview unavailable on ${project.port}`);
    }
    assert.equal(new Set(created.map(project => project.port)).size, 4);
    const tested = await request('executeCommand', { ...created[3], command: 'npm test', options }); assert.equal(tested.exitCode, 0, tested.stderr);
    console.log(JSON.stringify({ simultaneousFrameworks: ['Next.js', 'Vite/React', 'Expo Web', 'Node.js'], previews: '4 x HTTP 200', builds: '4 passed', nodeTests: 'passed' }));
  } finally { for (const project of created) await request('destroySandbox', project); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
