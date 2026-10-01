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
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Расследовать').click();
  });
  await page.waitForFunction(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    return !drawer.querySelector('textarea').disabled && !drawer.innerText.endsWith('…');
  }, { timeout: 120000 });
  const text = await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
  await page.screenshot({ path: '/test/investigation-success.png', fullPage: false });
  if (text.includes('Ошибка:')) throw new Error('Investigation request failed');
  if (!text.includes('Переданы результаты панелей: 3')) throw new Error('Investigation did not include live panel data');
  console.log(text);
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
