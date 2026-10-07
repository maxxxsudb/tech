const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  const originalPluginSettings = await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
    const settings = await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings').then((item) => item.json());
    if (settings.jsonData.provider === 'groq') {
      const save = await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, pinned: true, jsonData: { ...settings.jsonData, maxTokens: 600 } }),
      });
      if (!save.ok) throw new Error(`Temporary settings failed: ${save.status}`);
    }
    return settings.jsonData;
  });
  try {
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-24h&to=now', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
    await page.evaluate(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer');
      [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Расследовать').click();
    });
    await page.waitForSelector('[data-testid="tech-ai-investigation-setup"]', { visible: true, timeout: 10000 });
    await page.evaluate(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer');
      [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Начать расследование').click();
    });
    await page.waitForFunction(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer');
      return !drawer.querySelector('textarea').disabled && !drawer.innerText.endsWith('…');
    }, { timeout: 120000 });
    const text = await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
    await page.screenshot({ path: '/test/investigation-success.png', fullPage: false });
    const error = await page.$eval('#tech-ai-assistant-drawer [data-testid="tech-ai-error"]', (node) => node.textContent).catch(() => '');
    if (error) throw new Error(`Investigation request failed: ${error}`);
    if (!/Данные панелей: \d+ из 3/.test(text)) throw new Error('Investigation did not include live panel data');
    console.log(text);
  } finally {
    await page.evaluate(async (jsonData) => {
      await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, pinned: true, jsonData }),
      });
    }, originalPluginSettings);
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
