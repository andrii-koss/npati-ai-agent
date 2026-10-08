'use strict';
// TEMP probe (G1 item 5): does node:vm accept a shebang, and what does Node's own loader do with one?
const vm = require('node:vm');
const fs = require('node:fs');

const shebangSource = fs.readFileSync('scripts/security-gate-mutation-branch.mjs', 'utf8').split('\n').slice(0, 3).join('\n') + '\nexport const x = 1;\n';
const plain = fs.readFileSync('scripts/security-gate-mutation-branch.mjs', 'utf8');

for (const [label, source] of [['vm: 3-line shebang snippet', shebangSource], ['vm: full shebang file', plain]]) {
  try {
    new vm.Script(source, { filename: 'probe.mjs' });
    console.log(`${label}: ACCEPTED by node:vm`);
  } catch (error) {
    console.log(`${label}: REJECTED by node:vm -> ${error.message}`);
  }
}

// The bundler path: esbuild is what Vite uses to transform, so a shebang is either stripped by esbuild or not.
const esbuild = require('esbuild');
for (const [label, source] of [['esbuild(loader=js): full shebang file', plain], ['esbuild(loader=ts): full shebang file', plain]]) {
  const loader = label.includes('ts') ? 'ts' : 'js';
  esbuild.transform(source, { loader, format: 'esm' })
    .then((result) => {
      const first = result.code.split('\n')[0];
      console.log(`${label}: transformed, first line = ${JSON.stringify(first)}`);
    })
    .catch((error) => console.log(`${label}: FAILED -> ${error.message}`));
}
