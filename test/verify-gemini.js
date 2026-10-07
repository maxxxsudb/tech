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
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-24h&to=now', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
  await page.type('#tech-ai-assistant-drawer textarea', 'Объясни кратко, что делает этот дашборд и какие источники данных использует');
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Отправить').click();
  });
  await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true, timeout: 10000 });
  await page.click('[data-testid="tech-ai-send-preview"] button');
  await page.waitForFunction(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    const textarea = drawer.querySelector('textarea');
    return !textarea.disabled && !drawer.innerText.endsWith('…');
  }, { timeout: 90000 });
  const text = await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
  await page.screenshot({ path: '/test/gemini-success.png', fullPage: false });
  console.log(text);
  if (text.includes('Ошибка:')) throw new Error('Gemini request failed');
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
