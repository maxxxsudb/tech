const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const streamValues = [];
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (!request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) return request.continue();
    const body = JSON.parse(request.postData() || '{}');
    streamValues.push(body.stream);
    if (streamValues.length === 1) {
      request.respond({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { message: 'stream is not supported' } }) });
      return;
    }
    request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'NON_STREAM_FALLBACK_OK' } }] }) });
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
  await page.type('#tech-ai-assistant-drawer textarea', 'fallback test');
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Отправить').click();
  });
  await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('NON_STREAM_FALLBACK_OK'), { timeout: 30000 });
  await page.type('#tech-ai-assistant-drawer textarea', 'second fallback test');
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Отправить').click();
  });
  await page.waitForFunction(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    return !drawer.querySelector('textarea').disabled && (drawer.innerText.match(/NON_STREAM_FALLBACK_OK/g) || []).length === 2;
  }, { timeout: 30000 });
  console.log(JSON.stringify({ streamValues }));
  if (JSON.stringify(streamValues) !== JSON.stringify([true, false, false])) throw new Error(`Unexpected fallback sequence: ${JSON.stringify(streamValues)}`);
  await browser.close();
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
