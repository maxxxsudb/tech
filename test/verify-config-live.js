const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/plugins/tech-ai-assistant-app?page=configuration', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Проверить подключение'), { timeout: 30000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Проверить подключение').click());
  await page.waitForFunction(() => document.body.innerText.includes('✅'), { timeout: 120000 });
  const connection = await page.evaluate(() => [...document.querySelectorAll('div')].map((item) => item.textContent.trim()).find((text) => text.startsWith('✅')));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Загрузить список моделей').click());
  await page.waitForFunction(() => document.body.innerText.includes('Найдено моделей:'), { timeout: 60000 });
  const text = await page.evaluate(() => document.body.innerText);
  const match = text.match(/Найдено моделей: (\d+)/);
  console.log(JSON.stringify({ connection, models: match && Number(match[1]) }));
  if (!connection || !match || Number(match[1]) < 1) throw new Error('Live configuration check failed');
  await browser.close();
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
