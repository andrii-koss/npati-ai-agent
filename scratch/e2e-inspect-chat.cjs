const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const token = fs.readFileSync('scratch/e2e-token.txt', 'utf8').trim();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('requestfailed', r => console.log('REQFAIL', r.url(), r.failure()?.errorText));
  page.on('response', r => { if (r.url().includes('/api/')) console.log('RESP', r.status(), r.url().slice(0, 220)); });
  await page.addInitScript(t => {
    localStorage.setItem('npati_agent_access_token', t);
    localStorage.setItem('npati_agent_user', JSON.stringify({ id: '599402b8-b9d5-4676-a391-7b9db1a77026', email: 'dev@npati.local', username: 'dev', displayName: 'Dev User', role: 'owner' }));
  }, token);
  await page.goto('http://127.0.0.1:13001/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('URL', page.url());
  console.log('TITLE', await page.title());
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 5000));
  console.log('TEXTAREAS', await page.locator('textarea').count());
  console.log('BUTTONS', await page.locator('button').allTextContents());
  await page.screenshot({ path: 'scratch/chat-initial.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
