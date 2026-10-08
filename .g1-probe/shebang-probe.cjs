'use strict';
// TEMP probe (G1 item 5): list gate suites that import shebang scripts.
const fs = require('fs');
const src = fs.readFileSync('scripts/run-security-gate.mjs', 'utf8');
const m = src.match(/export const SECURITY_GATE_TESTS = \[([\s\S]*?)\n\];/);
const list = [...m[1].matchAll(/"(\/\/)?(tests\/[^"]+)"/g)].map((x) => x[2]);
console.log('gate suites:', list.length);
const rows = [];
for (const f of list) {
  const c = fs.readFileSync(f, 'utf8');
  const imports = [...c.matchAll(/from\s+"(\.\.\/scripts\/[^"]+\.mjs)"/g)].map((x) => x[1]);
  const sb = [];
  for (const i of imports) {
    const p = i.replace('../', '');
    const first = fs.readFileSync(p, 'utf8').split('\n')[0];
    if (first.startsWith('#!')) sb.push(p);
  }
  if (sb.length) rows.push([f, sb]);
}
console.log('gate suites importing shebang scripts:', rows.length);
for (const [f, sb] of rows) console.log('  ', f, '<=', sb.join(', '));
