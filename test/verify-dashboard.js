const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const diagnostics = [];
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`);
  });
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-24h&to=now', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
  try {
    await page.waitForFunction(() => document.body.innerText.includes('alice') && document.body.innerText.includes('Infinity: sales.csv'), { timeout: 30000 });
  } catch (error) {
    await page.screenshot({ path: '/test/dashboard-error.png', fullPage: true });
    console.error(JSON.stringify({ diagnostics, body: (await page.evaluate(() => document.body.innerText)).slice(0, 8000) }, null, 2));
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const body = await page.evaluate(() => document.body.innerText);
  const forbidden = ['Could not find plugin definition', 'dial tcp: lookup loki', 'Plugin unavailable'];
  const errors = forbidden.filter((message) => body.includes(message));
  if (errors.length) throw new Error(`Dashboard errors: ${errors.join(', ')}`);
  await page.screenshot({ path: '/test/dashboard-with-ai.png', fullPage: false });
  const dashboardUrl = page.url();
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForSelector('#tech-ai-assistant-drawer textarea[placeholder*="PromQL"]', { visible: true, timeout: 15000 });
  if (page.url() !== dashboardUrl) throw new Error('Dashboard URL changed when drawer opened');
  const result = {
    url: page.url(),
    context: (await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText)).includes('Tech stand · UID: tech'),
  };
  if (!result.context) throw new Error('Dashboard context was not preserved');
  await page.type('#tech-ai-assistant-drawer textarea[placeholder*="PromQL"]', 'покажи контекст');
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    const button = [...drawer.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Отправить');
    if (!button) throw new Error('Send button not found');
    button.click();
  });
  await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true, timeout: 10000 });
  await page.click('[data-testid="tech-ai-send-preview"] button');
  await page.waitForFunction(
    () => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('Полученный контекст Grafana:') && document.querySelector('#tech-ai-assistant-drawer').innerText.includes('"dashboardUid": "tech"'),
    { timeout: 15000 }
  );
  result.mockContextVisible = true;
  await page.screenshot({ path: '/test/dashboard-with-ai-drawer.png', fullPage: false });
  console.log(JSON.stringify({ launcher: true, dashboardErrors: errors, assistant: result, diagnostics }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
