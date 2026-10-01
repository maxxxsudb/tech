const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/plugins/tech-ai-assistant-app?page=configuration', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select', { visible: true, timeout: 30000 });
  const options = await page.$$eval('select option', (items) => items.map((item) => `${item.value}:${item.textContent}`));
  await page.select('select', 'groq');
  await page.waitForSelector('input[placeholder="gsk_…"]', { visible: true, timeout: 10000 });
  const endpointVisible = await page.evaluate(() => document.body.innerText.includes('https://api.groq.com/openai/v1/chat/completions'));
  await page.screenshot({ path: '/test/groq-config.png', fullPage: true });
  console.log(JSON.stringify({ options, endpointVisible }));
  if (!options.some((item) => item.startsWith('groq:')) || !endpointVisible) throw new Error('Groq profile is not rendered');
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
