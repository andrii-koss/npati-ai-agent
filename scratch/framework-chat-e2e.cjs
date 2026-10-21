// Real Chat UI create/edit E2E; Preview API restore is diagnostic only after explicit cleanup.
// Usage: node scratch/framework-chat-e2e.cjs ["Framework"]
// Optional: FRAMEWORK_ONLY, RESUME, QA_ONLY, QA_STOP_AFTER. Credentials are refreshed locally.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process'), { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:13001', company = 'e8fb3cc1-4809-4c95-a10a-1c7e2a57913b', out = path.resolve('artifacts/framework-chat-e2e-current');
fs.mkdirSync(out, { recursive: true });
let auth = JSON.parse(execFileSync('docker', ['exec', 'npati-isolated-source-20261011-agent-api-1', 'node', '/tmp/browser-session.cjs'], { encoding: 'utf8' }));
const frameworks = ['React + Vite', 'Vue 3 + Vite', 'Nuxt', 'SvelteKit', 'Astro', 'Angular', 'Remix', 'Express', 'Fastify', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Laravel', 'HTML/CSS'];
const selectedFramework = process.env.FRAMEWORK_ONLY || process.argv[2];
if (selectedFramework && !frameworks.includes(selectedFramework))
    throw Error('Unknown framework: ' + selectedFramework);
const backend = new Set(['Express', 'Fastify', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Laravel']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s).replace(/token=[^\s&"<>]+/g, 'token=REDACTED').replace(/Bearer [\w.\-]+/g, 'Bearer REDACTED');
function refreshAuth() { auth = JSON.parse(execFileSync('docker', ['exec', 'npati-isolated-source-20261011-agent-api-1', 'node', '/tmp/browser-session.cjs'], { encoding: 'utf8' })); }
async function api(p, method = 'GET', body, retried = false) { const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + auth.accessToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) }); if (r.status === 401 && !retried) {
    refreshAuth();
    return api(p, method, body, true);
} const text = await r.text(); let data; try {
    data = JSON.parse(text);
}
catch { } return { status: r.status, data }; }
async function processes() { const r = await api('/chat/development/processes'); if (r.status !== 200)
    throw Error('processes HTTP ' + r.status); return r.data.processes; }
function safe(value) { return JSON.parse(clean(JSON.stringify(value))); }
function save(r) { fs.writeFileSync(path.join(out, r.slug + '.json'), JSON.stringify(safe(r), null, 2)); }
function state(p) { return p ? { id: p.id, projectId: p.projectId, companyId: p.companyId, sessionId: p.sessionId, runId: p.runId, framework: p.framework, status: p.status, conversationId: p.conversationId, parentConversationId: p.parentConversationId, detail: p.detail, progress: p.progress } : null; }
async function waitNew(r, oldIds) { const end = Date.now() + 360000; while (Date.now() < end) {
    const all = await processes(), p = all.filter(p => !oldIds.has(p.id) && p.companyId === company).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (p) {
        r.initial = state(p);
        save(r);
        if (['completed', 'failed', 'cancelled', 'waiting_for_user', 'interrupted', 'suspended_by_flag'].includes(p.status))
            return p;
    }
    await sleep(6000);
} r.timeout = 'creation 360s'; if (r.initial)
    await api('/chat/development/processes/' + r.initial.id + '/stop', 'POST', {}); throw Error(r.timeout); }
async function qa(page, r, phase, marker) {
    refreshAuth();
    if (page.url() === 'about:blank')
        await page.goto(BASE + '/chat', { waitUntil: 'domcontentloaded' });
    await page.evaluate(a => { localStorage.setItem('npati_agent_access_token', a.accessToken); localStorage.setItem('npati_agent_user', JSON.stringify(a.user)); }, auth);
    const errors = [], consoleErrors = [], consoleMessages = [], hostFailures = [], resources = [], requestFailures = [];
    const onrequestfailed = req => { if (req.url().includes('/preview/proxy/'))
        requestFailures.push({ path: new URL(req.url()).pathname, error: req.failure()?.errorText }); };
    const onerror = e => errors.push(clean(e.message));
    const onconsole = m => { if (m.type() === 'error') {
        let source;
        try {
            source = new URL(m.location().url).pathname;
        }
        catch { }
        consoleMessages.push({ message: clean(m.text()).slice(0, 600), source });
    } };
    const onresponse = res => { const u = new URL(res.url()); if (res.request().frame() === page.mainFrame()) {
        if (res.status() >= 400)
            hostFailures.push({ path: u.pathname, status: res.status() });
        return;
    } resources.push({ path: u.pathname, status: res.status(), type: res.headers()['content-type'] }); };
    page.on('pageerror', onerror);
    page.on('console', onconsole);
    page.on('response', onresponse);
    page.on('requestfailed', onrequestfailed);
    try {
        await page.goto(BASE + '/c/' + (r.initial.parentConversationId || r.initial.conversationId) + '?company=' + company + '&project=' + r.initial.projectId + '&developmentRoot=' + (r.initial.parentConversationId || r.initial.conversationId), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        let restored;
        if ((process.env.QA_ONLY || process.env.RESUME) && (!await page.locator('.coding-preview-trigger').count() || !await page.locator('.coding-preview-trigger').last().isVisible())) {
            const project = (await api('/companies/' + company + '/projects/' + r.initial.projectId)).data;
            if (project?.createdBy !== auth.user.id || !project.description?.includes(r.marker))
                throw Error('diagnostic Preview restore ownership mismatch');
            const response = await api('/companies/' + company + '/projects/' + r.initial.projectId + '/preview/start', 'POST', {});
            restored = { http: response.status, status: response.data?.status, command: response.data?.command, port: response.data?.port, reason: 'Diagnostic restore of own completed Chat E2E project after explicit resource cleanup' };
            if (response.status !== 200)
                throw Error('diagnostic Preview restore HTTP ' + response.status);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000);
        }
        await page.locator('.coding-preview-trigger').last().waitFor({ timeout: 45000 });
        await page.locator('.coding-preview-trigger').last().click();
        const iframe = page.locator('iframe.project-chat-preview-frame');
        await iframe.waitFor({ timeout: 45000 });
        const frame = page.frameLocator('iframe.project-chat-preview-frame');
        await frame.locator('h1').first().waitFor({ timeout: 45000 });
        await page.waitForTimeout(1500);
        const result = await frame.locator('body').evaluate(el => ({ title: document.title, h1: document.querySelector('h1')?.textContent, text: el.innerText.slice(0, 6000), font: getComputedStyle(el).fontFamily, background: getComputedStyle(el).backgroundColor, css: [...document.styleSheets].map(s => s.href ? new URL(s.href).pathname : 'inline'), overflow: el.scrollWidth > innerWidth + 5, links: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, raw: a.getAttribute('href') })).slice(0, 12) }));
        if (restored)
            result.diagnosticRestore = restored;
        result.markerOk = result.h1?.includes(marker) && result.title.includes(marker);
        result.sectionOk = phase === 'initial' ? result.text.includes('Framework deployment verified') : result.text.includes('Оновлено через NPATI Chat');
        result.interaction = { attempted: false, passed: false };
        const button = frame.locator('button').filter({ hasText: /Click me|Натис|лічильн|Count/i }).first(), count = frame.locator('#count,.count,#counter-value,.counter-value').first();
        if (await button.count() && await count.count()) {
            const before = await count.textContent();
            await button.click({ timeout: 10000 });
            await page.waitForTimeout(300);
            const after = await count.textContent();
            result.interaction = { attempted: true, passed: before !== after, before, after };
        }
        const frameUrl = new URL(await iframe.getAttribute('src'), BASE), prefix = frameUrl.pathname.replace(/\/?$/, '/');
        result.previewPath = prefix;
        result.srcdoc = await iframe.getAttribute('srcdoc') !== null;
        if (backend.has(r.framework)) {
            const health = await page.request.get(BASE + prefix + 'health', { timeout: 20000 });
            result.health = { status: health.status(), body: (await health.text()).slice(0, 300) };
            try {
                result.health.ok = health.ok() && JSON.parse(result.health.body).status === 'ok';
            }
            catch {
                result.health.ok = false;
            }
        }
        const rawHtml = await page.request.get(BASE + prefix, { timeout: 20000 });
        const html = await rawHtml.text();
        result.documentHttp = rawHtml.status();
        result.serverRenderedH1 = /<h1[^>]*>[\s\S]*?<\/h1>/i.test(html) && html.includes(marker);
        await iframe.evaluate(el => { el.style.width = '375px'; });
        await page.waitForTimeout(200);
        result.mobile = await frame.locator('body').evaluate(el => ({ width: innerWidth, scrollWidth: el.scrollWidth, overflow: el.scrollWidth > innerWidth + 5 }));
        await page.screenshot({ path: path.join(out, r.slug + '-' + phase + '-mobile.png') });
        await iframe.evaluate(el => { el.style.width = ''; });
        result.anchorFailures = [];
        for (const a of result.links.filter(a => a.raw.startsWith('#') && a.raw.length > 1)) {
            if (!await frame.locator('body').evaluate((_, id) => Boolean(document.getElementById(id)), decodeURIComponent(a.raw.slice(1))))
                result.anchorFailures.push(a.raw);
        }
        result.brokenLinks = [];
        result.navigation = [];
        for (const a of result.links) {
            if (a.raw.startsWith('#') || !a.href.startsWith(BASE))
                continue;
            const child = page.frames().find(f => f.parentFrame() === page.mainFrame());
            try {
                const link = frame.locator('a[href]').filter({ visible: true });
                const candidates = await link.elementHandles();
                const handle = (await Promise.all(candidates.map(async (h) => ({ h, raw: await h.getAttribute('href') })))).find(x => x.raw === a.raw)?.h;
                if (!child || !handle)
                    throw Error('navigation anchor unavailable');
                const [response] = await Promise.all([child.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }), handle.click()]);
                const path = new URL(child.url()).pathname, status = response?.status() || 0;
                result.navigation.push({ raw: a.raw, path, status });
                if (status < 200 || status >= 400 || !path.startsWith(prefix))
                    result.brokenLinks.push({ path, status });
            }
            catch (e) {
                result.brokenLinks.push({ path: new URL(a.href).pathname, error: clean(e.message) });
            }
            finally {
                if (child) {
                    await child.goto(frameUrl.href, { waitUntil: 'load', timeout: 20000 });
                    await frame.locator('h1').first().waitFor({ timeout: 15000 });
                    await page.waitForTimeout(500);
                }
            }
        }
        result.hostConsoleErrors = consoleMessages.filter(e => e.source && hostFailures.some(h => h.path === e.source));
        result.hostHttpFailures = hostFailures;
        result.consoleMessages = consoleMessages;
        consoleErrors.push(...consoleMessages.filter(e => !e.source || !hostFailures.some(h => h.path === e.source)).map(e => e.message));
        result.styled = result.css.length > 0 && !result.font.includes('Times New Roman');
        result.requestFailures = requestFailures;
        result.errors = errors;
        result.consoleErrors = consoleErrors;
        result.resources = resources;
        result.resourceFailures = resources.filter(x => x.status >= 400 && !x.path.endsWith('favicon.ico'));
        result.passed = (!backend.has(r.framework) ? result.styled : true) && !requestFailures.length && (!['Nuxt', 'SvelteKit', 'Remix'].includes(r.framework) || result.serverRenderedH1) && result.documentHttp === 200 && !result.mobile.overflow && !result.anchorFailures.length && result.markerOk && result.sectionOk && !result.srcdoc && !errors.length && !consoleErrors.length && !result.brokenLinks.length && !result.resourceFailures.length && (backend.has(r.framework) ? result.health?.ok : result.interaction.passed);
        await page.screenshot({ path: path.join(out, r.slug + '-' + phase + '.png') });
        return result;
    }
    finally {
        page.off('pageerror', onerror);
        page.off('console', onconsole);
        page.off('response', onresponse);
        page.off('requestfailed', onrequestfailed);
    }
}
async function edit(page, r) { refreshAuth(); await page.evaluate(a => { localStorage.setItem('npati_agent_access_token', a.accessToken); localStorage.setItem('npati_agent_user', JSON.stringify(a.user)); }, auth); await page.getByRole('button', { name: 'Close preview', exact: true }).click().catch(() => { }); await page.goto(BASE + '/c/' + (r.initial.parentConversationId || r.initial.conversationId) + '?company=' + company + '&project=' + r.initial.projectId + '&developmentRoot=' + (r.initial.parentConversationId || r.initial.conversationId), { waitUntil: 'domcontentloaded' }); await page.locator('textarea').first().waitFor(); await page.waitForTimeout(4000); r.editPrompt = `Зміни заголовок головної сторінки (HTML title і H1) на «${r.editMarker}», додай нову секцію з текстом «Оновлено через NPATI Chat» та онови Live Preview. Не створюй новий проєкт — редагуй цей самий проєкт.`; const oldIds = new Set((await processes()).map(p => p.id)); await page.locator('textarea').first().fill(r.editPrompt); await page.getByRole('button', { name: 'Send', exact: true }).click(); const end = Date.now() + 240000; while (Date.now() < end) {
    const all = await processes();
    const unexpected = all.find(p => !oldIds.has(p.id) && p.companyId === company && (p.parentConversationId || p.conversationId) === (r.initial.parentConversationId || r.initial.conversationId));
    if (unexpected) {
        r.unexpectedProject = state(unexpected);
        await api('/chat/development/processes/' + unexpected.id + '/stop', 'POST', {});
        throw Error('edit created another project');
    }
    const p = all.find(p => p.id === r.initial.id);
    if (p && p.runId !== r.initial.runId) {
        r.edit = state(p);
        save(r);
        if (['completed', 'failed', 'cancelled', 'waiting_for_user', 'interrupted'].includes(p.status))
            return p;
    }
    await sleep(5000);
} r.timeout = 'edit 240s'; await api('/chat/development/processes/' + r.initial.id + '/stop', 'POST', {}); throw Error(r.timeout); }
async function main() {
    const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    try {
        if (process.env.QA_ONLY) {
            for (const framework of frameworks) {
                if (selectedFramework && framework !== selectedFramework)
                    continue;
                refreshAuth();
                const slug = framework.toLowerCase().replace(/[^a-z0-9]+/g, '-'), file = path.join(out, slug + '.json');
                if (!fs.existsSync(file))
                    continue;
                const r = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!r.editQa?.passed)
                    continue;
                const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
                await context.addInitScript(({ auth, company }) => { localStorage.setItem('npati_agent_access_token', auth.accessToken); localStorage.setItem('npati_agent_user', JSON.stringify(auth.user)); localStorage.setItem('npati_selected_company_id_v1', company); }, { auth, company });
                const page = await context.newPage();
                try {
                    r.finalQa = await qa(page, r, 'final', r.editMarker);
                    r.result = r.finalQa.passed && r.editQa?.passed && r.sameProject ? 'PASS' : 'PARTIAL';
                }
                catch (e) {
                    r.finalQa = { passed: false, error: clean(e.message) };
                    r.result = 'PARTIAL';
                }
                if (process.env.QA_STOP_AFTER) {
                    const stopped = await api('/companies/' + company + '/projects/' + r.initial.projectId + '/preview/stop', 'POST', {});
                    r.finalQa.previewStop = { http: stopped.status, status: stopped.data?.status };
                }
                save(r);
                console.log(JSON.stringify({ framework, stage: 'finalQa', passed: r.finalQa.passed, error: r.finalQa.error }));
                await context.close();
            }
            return;
        }
        for (const framework of frameworks) {
            const slug = framework.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            if (selectedFramework && framework !== selectedFramework)
                continue;
            if (fs.existsSync(path.join(out, slug + '.json')) && !process.env.RETEST && !process.env.RESUME)
                continue;
            refreshAuth();
            const r = { framework, slug, startedAt: new Date().toISOString(), result: 'FAIL', marker: 'NPATI ' + framework + ' Test26', editMarker: 'NPATI ' + framework + ' Edited26' };
            const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
            await context.addInitScript(({ auth, company }) => { localStorage.setItem('npati_agent_access_token', auth.accessToken); localStorage.setItem('npati_agent_user', JSON.stringify(auth.user)); localStorage.setItem('npati_selected_company_id_v1', company); }, { auth, company });
            const page = await context.newPage();
            page.setDefaultTimeout(20000);
            console.log(JSON.stringify({ framework, stage: 'start', at: r.startedAt }));
            try {
                if (process.env.RESUME && fs.existsSync(path.join(out, slug + '.json'))) {
                    const previous = JSON.parse(fs.readFileSync(path.join(out, slug + '.json'), 'utf8'));
                    Object.assign(r, previous);
                    delete r.error;
                    delete r.finishedAt;
                    delete r.timeout;
                    await page.goto(BASE + '/chat', { waitUntil: 'domcontentloaded' });
                    const deadline = Date.now() + 240000;
                    let p;
                    while (Date.now() < deadline) {
                        p = (await processes()).find(p => p.id === r.initial.id);
                        r.resumedProcessState = state(p);
                        if (r.initial?.status !== 'completed' && (!r.initial?.runId || r.initial.runId === p?.runId))
                            r.initial = state(p);
                        save(r);
                        if (['completed', 'failed', 'cancelled', 'waiting_for_user', 'interrupted'].includes(p.status))
                            break;
                        await sleep(6000);
                    }
                    if (p.status !== 'completed')
                        throw Error('resumed creation ' + p.status);
                    r.initialQa = await qa(page, r, 'initial', r.marker);
                    if (!r.initialQa.passed)
                        throw Error('resumed initial QA failed');
                    const changed = await edit(page, r);
                    if (changed.status !== 'completed')
                        throw Error('resumed edit ' + changed.status);
                    r.editQa = await qa(page, r, 'edited', r.editMarker);
                    r.sameProject = changed.projectId === p.projectId;
                    r.result = r.editQa.passed && r.sameProject ? 'PASS' : 'PARTIAL';
                    continue;
                }
                const oldIds = new Set((await processes()).map(p => p.id));
                await page.goto(BASE + '/chat', { waitUntil: 'domcontentloaded' });
                const select = page.getByRole('combobox', { name: 'Active context', exact: true });
                await select.locator('option[value="company:' + company + '"]').waitFor({ state: 'attached', timeout: 60000 });
                await select.selectOption('company:' + company);
                await page.waitForTimeout(1500);
                r.prompt = backend.has(framework) ? `Створи мінімальний працездатний застосунок на ${framework}. Головна HTML-сторінка має H1 і title «${r.marker}», навігацію, абзац «Framework deployment verified» та /health JSON зі status ok. Встанови залежності, виконай production build або відповідну backend перевірку і запусти Live Preview.` : `Створи сучасний адаптивний тестовий сайт на ${framework}${['Nuxt', 'SvelteKit'].includes(framework) ? ' (SSR)' : framework === 'Astro' ? ' (Static)' : ''}. Головна сторінка: HTML title і H1 «${r.marker}», навігація, абзац «Framework deployment verified» та інтерактивний лічильник з кнопкою «Click me» і числом. Встанови залежності, виконай production build та запусти Live Preview. Використай наявний starter без зайвих сторінок.`;
                await page.locator('textarea').first().fill(r.prompt);
                await page.getByRole('button', { name: 'Send', exact: true }).click();
                r.submittedAt = new Date().toISOString();
                save(r);
                const p = await waitNew(r, oldIds);
                console.log(JSON.stringify({ framework, stage: 'created', status: p.status, projectId: p.projectId, runId: p.runId }));
                if (p.framework !== framework)
                    throw Error('framework mismatch: ' + p.framework);
                if (p.status !== 'completed')
                    throw Error('creation ' + p.status + ': ' + (p.detail || p.progress?.filter(x => x.status === 'failed').at(-1)?.title || ''));
                r.initialQa = await qa(page, r, 'initial', r.marker);
                save(r);
                if (!r.initialQa.passed)
                    throw Error('initial Browser QA failed');
                const changed = await edit(page, r);
                if (changed.status !== 'completed')
                    throw Error('edit ' + changed.status);
                r.editQa = await qa(page, r, 'edited', r.editMarker);
                r.sameProject = changed.projectId === p.projectId;
                r.result = r.editQa.passed && r.sameProject ? 'PASS' : 'FAIL';
            }
            catch (e) {
                r.error = clean(e.stack || e.message);
                if (r.initialQa?.passed)
                    r.result = 'PARTIAL';
                await page.screenshot({ path: path.join(out, slug + '-error.png') }).catch(() => { });
            }
            finally {
                if (r.initial?.projectId) {
                    r.previewStatus = (await api('/companies/' + company + '/projects/' + r.initial.projectId + '/preview/status')).data;
                    r.project = (await api('/companies/' + company + '/projects/' + r.initial.projectId)).data;
                    r.activity = (await api('/companies/' + company + '/code/runs/' + r.initial.runId + '/activity')).data;
                    if (r.edit?.runId)
                        r.editActivity = (await api('/companies/' + company + '/code/runs/' + r.edit.runId + '/activity')).data;
                }
                r.finishedAt = new Date().toISOString();
                save(r);
                console.log(JSON.stringify({ framework, result: r.result, error: r.error?.split('\n')[0], runId: r.initial?.runId, editRunId: r.edit?.runId }));
                await context.close();
            }
        }
    }
    finally {
        await browser.close();
    }
}
main().catch(e => { console.error(clean(e.stack)); process.exitCode = 1; });
