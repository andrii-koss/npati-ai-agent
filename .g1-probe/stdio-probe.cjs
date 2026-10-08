'use strict';
// TEMP probe (G1 item 5): which child-process shapes does the sandbox allow?
const { spawnSync } = require('node:child_process');
const cases = [
  ['pipe', { encoding: 'utf8' }],
  ['inherit', { stdio: 'inherit' }],
  ['ignore', { stdio: 'ignore' }],
];
for (const [label, options] of cases) {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("child-out")'], options);
  console.log(`${label}: error=${result.error ? result.error.code : 'none'} status=${result.status} stdout=${JSON.stringify(String(result.stdout ?? ''))}`);
}
