const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:13001';
const COMPANY_ID = 'e8fb3cc1-4809-4c95-a10a-1c7e2a57913b';
const TOKEN = fs.readFileSync(path.join(__dirname, 'e2e-token.txt'), 'utf8').trim();
const OUT_DIR = path.join(__dirname, 'framework-e2e');
fs.mkdirSync(OUT_DIR, { recursive: true });

const framework = process.argv[2];
if (!framework) throw new Error('Usage: node framework-chat-e2e.cjs "<framework>"');
const backend = ['Express', 'Fastify', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Laravel'].includes(framework);
const slug = framework.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const resultPath = path.join(OUT_DIR, `${slug}.json`);
const before = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : {};

function promptFor(framework) {
  if (['Express', 'Fastify', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Laravel'].includes(framework)) {
    return `Створи мінімальний працездатний застосунок на ${framework}. Головний маршрут має повертати HTML з H1 «NPATI ${framework} Test» і абзацом «Framework deployment verified», а /health — JSON зі status ok. Встанови залежності, виконай production build (або відповідну перевірку для backend) і запусти Live Preview.`;
  }
  const suffix = framework === 'Nuxt' ? ' (SSR)' : framework === 'SvelteKit' ? ' (SSR)' : framework === 'Astro' ? ' (static)' : '';
  return `Створи тестовий сайт на ${framework}${suffix}, використовуючи готовий starter. Головна сторінка, навігація та лічильник уже є. Зміни H1 і HTML title на «NPATI ${framework} Test» та додай короткий абзац «Framework deployment verified». Не створюй нових сторінок чи компонентів. Виконай production build і запусти Live Preview.`;
}

async function api(pathname, options = {}) {
  const response = await fetch(BASE + '/api' + pathname, {
    ...options,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, text };
}

async function waitForTerminalProcess(conversationId, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await api('/chat/development/processes');
    const processes = data?.processes || [];
    const candidates = processes
      .filter(p => p.createdAt && Date.parse(p.createdAt) >= startedAt - 5000)
      .filter(p => p.conversationId === conversationId || p.parentConversationId === conversationId);
    const process = candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (process) {
      last = process;
      console.log(`[${framework}] status=${process.status} project=${process.projectId || '-'} progress=${(process.progress || []).length} detail=${(process.detail || '').slice(0, 160)}`);
      if (['completed', 'failed', 'cancelled', 'interrupted', 'suspended_by_flag'].includes(process.status)) return process;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for ${framework}; last status: ${last?.status || 'none'} ${last?.detail || ''}`);
}

async function waitForProjectChange(companyId, projectId, previousUpdatedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await api(`/companies/${companyId}/projects/${projectId}`);
    last = data?.project || data;
    const updated = last?.updatedAt;
    if (updated && updated !== previousUpdatedAt && last?.previewUrl && last?.lastBuildStatus === 'ready') return last;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Project did not publish an updated preview; last=${JSON.stringify({ updatedAt: last?.updatedAt, previewUrl: last?.previewUrl, lastBuildStatus: last?.lastBuildStatus, status: last?.status })}`);
}

/**
 * Backend edits change workspace files without changing the Project row's updatedAt.
 * Wait for the observable result instead: the running preview serves the edited title.
 */
async function waitForEditedPreview(companyId, projectId, expectedTitle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await api(`/companies/${companyId}/projects/${projectId}`);
    last = data?.project || data;
    if (last?.previewUrl && last?.status === 'previewing') {
      try {
        const response = await fetch(BASE + last.previewUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
        const body = await response.text();
        if (response.ok && body.includes(expectedTitle)) return last;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Project preview did not show the edited title; last=${JSON.stringify({ updatedAt: last?.updatedAt, previewUrl: last?.previewUrl, status: last?.status })}`);
}

async function browserQa(context, previewUrl, expectedTitleIncludes, expectedSectionText, screenshotName) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
  page.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 500)));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  const response = await page.goto(BASE + previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const title = await page.title();
  const h1 = await page.locator('h1').first().textContent().catch(() => null);
  const body = (await page.locator('body').innerText()).slice(0, 4000);
  let interaction = { attempted: false, passed: false, before: null, after: null, error: null };
  const counter = page.locator('#counter, button').filter({ hasText: /click me/i }).first();
  if (await counter.count()) {
    interaction.attempted = true;
    try {
      const countBefore = await page.locator('#count, .count').first().textContent().catch(() => null);
      await counter.click({ timeout: 10000 });
      await page.waitForTimeout(750);
      const countAfter = await page.locator('#count, .count').first().textContent().catch(() => null);
      interaction = { attempted: true, passed: countBefore !== countAfter, before: countBefore, after: countAfter, error: null };
    } catch (error) { interaction.error = String(error.message); }
  }
  const hrefs = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => a.href).filter(Boolean));
  const brokenLinks = [];
  for (const href of [...new Set(hrefs)].slice(0, 20)) {
    try {
      const url = new URL(href);
      if (url.origin !== new URL(BASE).origin || url.hash) continue;
      const res = await page.request.get(href, { timeout: 15000 });
      if (res.status() >= 400) brokenLinks.push({ href, status: res.status() });
    } catch (error) { brokenLinks.push({ href, error: String(error.message) }); }
  }
  await page.screenshot({ path: path.join(OUT_DIR, screenshotName), fullPage: true });
  const titleOk = !expectedTitleIncludes || title.includes(expectedTitleIncludes);
  const sectionOk = !expectedSectionText || body.includes(expectedSectionText);
  await page.close();
  return {
    httpStatus: response?.status() ?? null,
    title, h1, titleOk, sectionOk, interaction, consoleErrors, pageErrors, failedRequests, brokenLinks,
    passed: (response?.status() || 0) < 400 && titleOk && sectionOk && consoleErrors.length === 0 && pageErrors.length === 0
      && (interaction.attempted ? interaction.passed === true : true) && brokenLinks.length === 0,
    bodySample: body.slice(0, 1000),
  };
}

(async () => {
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(token => {
    localStorage.setItem('npati_agent_access_token', token);
    localStorage.setItem('npati_agent_user', JSON.stringify({ id: '599402b8-b9d5-4676-a391-7b9db1a77026', email: 'dev@npati.local', username: 'dev', displayName: 'Dev User', role: 'owner' }));
    localStorage.setItem('npati_selected_company_id_v1', 'e8fb3cc1-4809-4c95-a10a-1c7e2a57913b');
    sessionStorage.setItem('npati_selected_company_id_v1', 'e8fb3cc1-4809-4c95-a10a-1c7e2a57913b');
  }, TOKEN);
  const page = await context.newPage();
  page.on('pageerror', error => console.log(`[${framework}] PAGEERROR`, error.message));
  await page.goto(BASE + '/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('textarea', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const selectedContext = await page.locator('select[aria-label="Active context"]').inputValue().catch(() => null);
  if (selectedContext !== `company:${COMPANY_ID}`) {
    await page.locator('select[aria-label="Active context"]').selectOption(`company:${COMPANY_ID}`).catch(async () => {
      await page.locator('select[aria-label="Active context"]').selectOption({ label: 'New' });
    });
    await page.waitForTimeout(1000);
  }

  const prompt = promptFor(framework);
  console.log(`[${framework}] PROMPT ${prompt}`);
  await page.locator('textarea').first().fill(prompt);
  await page.locator('textarea').first().press('Enter');

  let chatUrl = page.url();
  let conversationId = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    await page.waitForTimeout(2000);
    chatUrl = page.url();
    if (chatUrl.includes('/c/')) {
      conversationId = new URL(chatUrl).pathname.split('/').filter(Boolean)[1] || '';
      if (conversationId) break;
    }
    const { data } = await api('/chat/development/processes');
    const created = (data?.processes || [])
      .filter(p => p.framework === framework && p.createdAt && Date.parse(p.createdAt) >= startedAt - 5000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (created) {
      conversationId = created.conversationId || created.parentConversationId || '';
      if (conversationId) {
        chatUrl = `${BASE}/c/${conversationId}?company=${COMPANY_ID}`;
        break;
      }
    }
  }
  console.log(`[${framework}] CHAT ${chatUrl}`);
  if (!conversationId) throw new Error(`No conversation id for ${framework}; last URL ${chatUrl}`);
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const process = await waitForTerminalProcess(conversationId, startedAt, 25 * 60 * 1000);
  if (!process.projectId) throw new Error(`Process ${process.id} has no projectId: ${process.detail}`);
  const projectId = process.projectId;

  let project = (await api(`/companies/${COMPANY_ID}/projects/${projectId}`)).data;
  project = project?.project || project;
  const preview = (await api(`/companies/${COMPANY_ID}/projects/${projectId}/preview/status`)).data;
  if (!preview?.previewUrl) throw new Error(`No Live Preview URL; project=${JSON.stringify({ status: project?.status, lastBuildStatus: project?.lastBuildStatus, previewUrl: project?.previewUrl })}`);
  const initialPreviewUrl = preview.previewUrl;
  console.log(`[${framework}] PREVIEW ${initialPreviewUrl}`);

  const initialQa = await browserQa(context, initialPreviewUrl, `NPATI ${framework} Test`, 'Framework deployment verified', `${slug}-initial.png`);

  // Return to the same conversation and send the required edit request.
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('textarea', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const beforeEditProject = (await api(`/companies/${COMPANY_ID}/projects/${projectId}`)).data;
  const beforeUpdatedAt = (beforeEditProject?.project || beforeEditProject)?.updatedAt;
  const newTitle = `NPATI ${framework} E2E`;
  const editPrompt = `Зміни заголовок головної сторінки (HTML title і H1) на «${newTitle}», додай нову секцію з текстом «Оновлено через NPATI Chat» та онови Live Preview. Не створюй новий проєкт — редагуй цей самий проєкт.`;
  console.log(`[${framework}] EDIT ${editPrompt}`);
  await page.locator('textarea').first().fill(editPrompt);
  await page.locator('textarea').first().press('Enter');

  // Wait for a new project update and a ready preview.
  const editedProject = backend
    ? await waitForEditedPreview(COMPANY_ID, projectId, `NPATI ${framework} E2E`, 20 * 60 * 1000)
    : await waitForProjectChange(COMPANY_ID, projectId, beforeUpdatedAt, 20 * 60 * 1000);
  const editedPreviewUrl = editedProject.previewUrl;
  console.log(`[${framework}] EDITED PREVIEW ${editedPreviewUrl}`);
  const editQa = await browserQa(context, editedPreviewUrl, newTitle, 'Оновлено через NPATI Chat', `${slug}-edited.png`);
  const finalActivity = (await api(`/companies/${COMPANY_ID}/code/runs/${process.runId}/activity`)).data;

  const report = {
    framework, prompt, editPrompt, chatUrl, conversationId,
    process: {
      id: process.id, status: process.status, projectId, sessionId: process.sessionId ?? null,
      runId: process.runId ?? null, framework: process.framework, detail: process.detail ?? null,
      progress: process.progress ?? [],
    },
    initialProject: { framework: project?.framework, status: project?.status, lastBuildStatus: project?.lastBuildStatus, previewUrl: initialPreviewUrl },
    initialQa,
    editedProject: { framework: editedProject?.framework, status: editedProject?.status, lastBuildStatus: editedProject?.lastBuildStatus, previewUrl: editedPreviewUrl, updatedAt: editedProject?.updatedAt },
    editQa,
    activity: finalActivity,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.log(`[${framework}] RESULT`, JSON.stringify({
    processStatus: process.status,
    initial: { http: initialQa.httpStatus, title: initialQa.title, consoleErrors: initialQa.consoleErrors.length, pageErrors: initialQa.pageErrors.length, brokenLinks: initialQa.brokenLinks, interaction: initialQa.interaction },
    edited: { http: editQa.httpStatus, title: editQa.title, titleOk: editQa.titleOk, sectionOk: editQa.sectionOk, profile: 'see json' },
  }, null, 2));
  await browser.close();
  if (process.status !== 'completed' || !initialQa.passed || !editQa.passed) process.exitCode = 2;
})().catch(async error => {
  console.error(`[${framework}] FAILED`, error);
  fs.writeFileSync(resultPath, JSON.stringify({ ...before, framework, error: String(error.stack || error), at: new Date().toISOString() }, null, 2));
  process.exit(1);
});
