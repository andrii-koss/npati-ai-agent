// README screenshots in English from the local stand. "demo" builds a clean Morning Bakery company through the real
// chat (website, browser game, database); "shots" takes the screenshots into docs/media/screenshots.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { auth, request, origin, sql } from './v6-step13-audit.mjs';

const out = 'docs/media/screenshots';
fs.mkdirSync(out, { recursive: true });
const statePath = 'artifacts/readme-screenshots-state.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const saveState = () => { fs.mkdirSync('artifacts', { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); };
const credentials = auth(), token = credentials.accessToken;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function chat(body) {
  const res = await fetch(origin + '/api/chat/stream', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, streamId: randomUUID() }) });
  const text = await res.text();
  const result = text.split('\n\n').filter(b => b.includes('event: result')).map(b => JSON.parse(b.split('\n').find(l => l.startsWith('data: ')).slice(6))).at(-1);
  const started = text.match(/"conversationId":"([0-9a-f-]{36})"/);
  return { conversationId: result?.conversationId ?? started?.[1], message: result?.message ?? '', activeContext: result?.activeContext };
}
const projectId = name => sql(`select id from projects where company_id='${state.companyId}' and name='${name}' and deleted_at is null limit 1`);

if (process.argv[2] === 'demo') {
  if (!state.companyId) {
    const c = await request(token, '/companies', { name: 'Morning Bakery', description: 'A family bakery in Lviv: sourdough bread, pastries and coffee. Fresh bread every morning.' });
    state.companyId = c.body?.company?.id ?? c.body?.id; saveState();
  }
  if (!state.siteChat) {
    const r = await chat({ message: 'Create a website for Morning Bakery named "Morning Bakery Site": warm cream and brown colors, a hero heading "Fresh bread every morning", a short about section, a menu with three breads and prices, and an Order button. Plain HTML, CSS and JavaScript, in English.', companyId: state.companyId, contextType: 'company' });
    state.siteChat = r.conversationId; state.siteId = projectId('Morning Bakery Site'); saveState();
    console.log('site', state.siteId, r.message.slice(0, 160));
  }
  if (!state.gameChat) {
    const r = await chat({ message: 'Create a browser game "Bakery Snake": a snake on an HTML canvas that collects croissants, arrow keys to move, a score on screen and a Restart button. English text.', companyId: state.companyId, contextType: 'company' });
    state.gameChat = r.conversationId; state.gameId = projectId('Bakery Snake'); saveState();
    console.log('game', state.gameId, r.message.slice(0, 160));
  }
  if (!state.dbDone && state.siteId) {
    const started = Date.now(); let stop = false;
    const approver = (async () => { while (!stop) { for (const a of JSON.parse(sql(`select coalesce(json_agg(r),'[]') from (select id from company_approvals where company_id='${state.companyId}' and status='pending' and requested_at >= to_timestamp(${started / 1000})) r`))) await request(token, `/companies/${state.companyId}/approvals/${a.id}/decide`, { decision: 'approved', notes: 'README demo' }); await wait(2000); } })();
    const r = await chat({ message: 'For the Morning Bakery Site create a database with a products table (name, price in UAH, category, in stock) and add six real-looking bakery products.', companyId: state.companyId, projectId: state.siteId, contextType: 'project', conversationId: state.siteChat });
    stop = true; await approver; state.dbDone = true; saveState();
    console.log('db', r.message.slice(0, 160));
  }
  console.log(JSON.stringify(state));
} else if (process.argv[2] === 'shots') {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(c => { localStorage.setItem('npati_agent_access_token', c.accessToken); localStorage.setItem('npati_agent_user', JSON.stringify(c.user)); localStorage.setItem('npati_language', 'en'); }, credentials);
  const page = await context.newPage();
  const shot = async name => { await wait(1500); await page.screenshot({ path: `${out}/${name}.png` }); console.log('saved', name); };
  // Only the demo chats stay in the sidebar and the owner's avatar is hidden: the stand also holds test chats.
  const tidy = () => page.evaluate(() => {
    for (const row of document.querySelectorAll(".sidebar-history-row")) if (!/Morning Bakery|browser game .Bakery Snake/i.test(row.textContent || "") && !/^Create a (website for Morning|browser game)/.test((row.textContent || "").trim())) row.style.display = "none";
    for (const a of document.querySelectorAll(".chat-user-avatar")) a.style.visibility = "hidden";
  });
  const go = async (url) => { await page.goto(origin + url); await wait(2500); await tidy(); };
  try {
    await go(`/c/${state.siteChat}`); await page.locator("article.assistant").last().waitFor({ timeout: 60000 });
    const card = page.getByTestId("chat-project-preview-card").first(); await card.waitFor({ timeout: 60000 }); await card.locator(".coding-preview-trigger").click();
    await page.locator(".project-chat-preview-viewport iframe").last().waitFor(); await wait(5000);
    await page.locator(".message-stream").first().evaluate(e => e.scrollTo(0, 0)).catch(() => {}); await wait(800); await tidy(); await shot("chat-website");
    await go(`/c/${state.gameChat}`); await page.locator("article.assistant").last().waitFor({ timeout: 60000 });
    const gcard = page.getByTestId("chat-project-preview-card").last(); await gcard.waitFor({ timeout: 60000 }); await gcard.locator(".coding-preview-trigger").click();
    const frame = page.locator(".project-chat-preview-viewport iframe").last(); await frame.waitFor(); await wait(4000);
    const game = frame.contentFrame(); await game.getByRole("button", { name: /Start game/i }).click().catch(() => {}); await wait(500);
    for (const k of ["ArrowRight", "ArrowDown", "ArrowRight", "ArrowUp"]) { await page.keyboard.press(k); await wait(700); }
    await tidy(); await shot("game");
    await go("/settings"); await shot("overview");
    await go("/settings/projects");
    await page.locator(".company-select").first().click(); const dialog = page.locator(".company-scope-popover[role=dialog]"); await dialog.waitFor();
    await dialog.getByRole("combobox").fill("Morning Bakery"); await dialog.getByRole("option", { name: /Morning Bakery/ }).first().click(); await wait(2500); await tidy(); await shot("projects");
    await go(`/projects/${state.companyId}/${state.siteId}/data`); await page.locator("table").first().waitFor({ timeout: 60000 }).catch(() => {}); await tidy(); await shot("data-studio");
    await go("/chat"); const lang = page.locator(".npati-language-trigger").first(); if (await lang.count()) { await lang.click(); await wait(800); } await tidy(); await shot("languages");
  } finally { await browser.close(); }
}
