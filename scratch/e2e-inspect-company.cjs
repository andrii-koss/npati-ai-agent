const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const token = fs.readFileSync('scratch/e2e-token.txt', 'utf8').trim();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.addInitScript(t => {
    localStorage.setItem('npati_agent_access_token', t);
    localStorage.setItem('npati_agent_user', JSON.stringify({ id: '599402b8-b9d5-4676-a391-7b9db1a77026', email: 'dev@npati.local', username: 'dev', displayName: 'Dev User', role: 'owner' }));
    localStorage.setItem('npati_selected_company_id_v1', 'e8fb3cc1-4809-4c95-a10a-1c7e2a57913b');
    sessionStorage.setItem('npati_selected_company_id_v1', 'e8fb3cc1-4809-4c95-a10a-1c7e2a57913b');
  }, token);
  await page.goto('http://127.0.0.1:13001/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('BODY', (await page.locator('body').innerText()).slice(-1500));
  console.log('TEXTAREAS', await page.locator('textarea').count());
  console.log('TEXTAREA PLACEHOLDERS', await page.locator('textarea').evaluateAll(els => els.map(e => e.placeholder)));
  console.log('SEND', await page.locator('button[aria-label="Send"]').count());
  await page.screenshot({ path: 'scratch/chat-company.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
