'use strict';
// TEMP probe (G1 item 5): re-run the size guard's own readers against the document, exactly as
// `tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts` does.
const fs = require('node:fs');

const report = fs.readFileSync('docs/coding-agent/security-gate-report.md', 'utf8');
const librarySource = fs.readFileSync('scripts/lib/run-security-gate.mjs', 'utf8');

const marker = 'export const SECURITY_GATE_TESTS = [';
const start = librarySource.indexOf(marker);
const end = librarySource.indexOf('\n];', start);
const suites = [];
for (const match of librarySource.slice(start, end).matchAll(/^\s*"([^"]+)",\s*$/gm)) suites.push(match[1]);
const gateSize = suites.length;

const sizeClaims = [];
const missingClaims = [];
const missingShapes = [];
const single = (shape, pattern) => {
  const match = pattern.exec(report);
  if (!match || match[1] === undefined) {
    missingShapes.push(shape);
    return;
  }
  sizeClaims.push({ shape, value: Number(match[1]) });
};
single('canonical sentence (Поточний розмір фіксованого списку гейта)', /Поточний розмір фіксованого списку гейта[^\n]*?\*\*(\d+)\*\*/);
single('`--list` row', /`node scripts\/run-security-gate\.mjs --list`[^\n]*?\*\*(\d+)\*\*/);
for (const match of report.matchAll(/→\s*\*\*(\d+)\*\*/g)) sizeClaims.push({ shape: 'bold number after an arrow', value: Number(match[1]) });
for (const match of report.matchAll(/suites=(\d+) present=(\d+) missing=(\d+)/g)) {
  sizeClaims.push({ shape: 'suites=', value: Number(match[1]) });
  sizeClaims.push({ shape: 'present=', value: Number(match[2]) });
  missingClaims.push({ shape: 'missing=', value: Number(match[3]) });
}

console.log('parsed suite count :', gateSize);
console.log('size claims        :', sizeClaims.length);
for (const claim of sizeClaims) console.log(`  ${claim.value === gateSize ? 'ok  ' : 'MISMATCH'} ${claim.shape} = ${claim.value}`);
console.log('missing claims     :', missingClaims.map((c) => c.value).join(', '));
console.log('missing shapes     :', JSON.stringify(missingShapes));
const bad = sizeClaims.filter((c) => c.value !== gateSize);
const badMissing = missingClaims.filter((c) => c.value !== 0);
console.log(bad.length === 0 && badMissing.length === 0 && missingShapes.length === 0 && sizeClaims.length >= 4 ? '\nSIZE GUARD: PASS' : '\nSIZE GUARD: FAIL');
process.exitCode = bad.length === 0 && badMissing.length === 0 && missingShapes.length === 0 && sizeClaims.length >= 4 ? 0 : 1;
