// Run inside the API container, under /app so the installed pg package resolves.
// Uses the installation owner's real session/model and creates one persistent test site.
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

(async () => {
  const state = JSON.parse(await fs.readFile('/app/data/installation-auth.json', 'utf8'));
  const sessionResponse = await fetch(new URL('/api/v1/agent-installations/session', process.env.NPATI_BACKEND_URL), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${state.installationToken}` }, body: '{}',
  });
  const session = (await sessionResponse.json()).data;
  if (!sessionResponse.ok || !session?.accessToken) throw Error('Installation owner session unavailable');
  const started = Date.now();
  const response = await fetch('http://web:3000/api/chat/stream', {
    method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview', contextType: 'none', streamId: randomUUID() }),
    signal: AbortSignal.timeout(900000),
  });
  if (!response.ok) throw Error(`Chat HTTP ${response.status}`);
  let transcript = ''; const decoder = new TextDecoder();
  for await (const chunk of response.body) transcript += decoder.decode(chunk, { stream: true });
  transcript += decoder.decode();
  const results = transcript.split(/\r?\n\r?\n/).flatMap(block => {
    if (!/^event: (result|error)$/m.test(block)) return [];
    return [JSON.parse(block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'))];
  });
  const result = results.at(-1); const card = result?.projectCard;
  if (!card || card.buildStatus !== 'success' || card.status !== 'previewing' || !card.previewUrl) {
    throw Error(`Chat did not produce a built preview: ${JSON.stringify({ error: result?.error, status: card?.status, build: card?.buildStatus })}`);
  }
  const url = new URL(card.previewUrl, 'http://web:3000'); url.host = 'web:3000';
  const page = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const html = await page.text();
  if (page.status !== 200 || !html.includes('/_next/')) throw Error(`Next.js Preview failed: HTTP ${page.status}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query('SELECT command_summary,status,exit_code,duration_ms FROM project_terminal_events WHERE project_id=$1 ORDER BY created_at', [card.projectId]);
    if (!rows.some(row => row.command_summary === 'npm run build' && row.status === 'completed' && row.exit_code === 0)) throw Error('No successful production build event');
    console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), projectId: card.projectId, runId: card.runId, build: card.buildStatus, previewHttpStatus: page.status, nextHtmlBytes: html.length, commands: rows }, null, 2));
  } finally { await pool.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
