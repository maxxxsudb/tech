const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    const getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 700;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#143d73';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 96px sans-serif';
      ctx.fillText('SCREENSHOT TEST 742', 80, 370);
      return canvas.captureStream(1);
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });
  });
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
  await page.click('#tech-ai-assistant-drawer input[type="checkbox"]');
  await page.type('#tech-ai-assistant-drawer textarea', 'Какой крупный текст изображён на приложенном снимке? Ответь только этим текстом.');
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Отправить').click();
  });
  await page.waitForFunction(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    const textarea = drawer.querySelector('textarea');
    return !textarea.disabled && !drawer.innerText.endsWith('…');
  }, { timeout: 120000 });
  const text = await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
  await page.screenshot({ path: '/test/gemini-image-success.png', fullPage: false });
  console.log(text);
  if (text.includes('Ошибка:')) throw new Error('Gemini image request failed');
  if (!text.includes('Передан снимок: 1200×700')) throw new Error('Screenshot metadata is not shown');
  if (!text.toUpperCase().includes('SCREENSHOT TEST 742')) throw new Error('Gemini did not read the screenshot');
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
