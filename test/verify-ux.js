const puppeteer = require('puppeteer');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      response.flushHeaders();
      let index = 0;
      const timer = setInterval(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Строка потокового ответа ${++index}\n\n` } }] })}\n\n`);
        if (index === 80) { clearInterval(timer); response.end('data: [DONE]\n\n'); }
      }, 80);
      response.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let settings, preferences;
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  try {
    await page.setViewport({ width: 1280, height: 650 });
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const login = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!login.ok) throw new Error(`Login: ${login.status}`);
    });
    settings = await page.evaluate(async (port) => {
      const url = '/crf/dashboard/api/plugins/tech-ai-assistant-app/settings';
      const original = await (await fetch(url)).json();
      const save = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, jsonData: { ...original.jsonData, provider: 'custom', apiUrl: `http://127.0.0.1:${port}`, apiPath: '/v1/chat/completions', model: 'ux-stream-test', useAuth: false, streaming: true } }) });
      if (!save.ok) throw new Error(`Test setup: ${save.status}`);
      return { enabled: original.enabled, pinned: original.pinned, jsonData: original.jsonData };
    }, server.address().port);
    preferences = await page.evaluate(async () => (await fetch('/crf/dashboard/api/user/preferences')).json());
    const dashboard = 'http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?from=now-1h&to=now';
    await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true });
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    assert.equal(await page.$eval('[data-testid="tech-ai-actions-panel"]', (node) => node.open), false);
    assert.equal(await page.$eval('[data-testid="tech-ai-more-actions"]', (node) => node.open), false);
    await page.type('#tech-ai-assistant-drawer textarea', 'Сохранённый черновик\nВторая строка\nТретья строка');
    await page.waitForFunction(() => sessionStorage.getItem('tech-ai-chat:tech:draft')?.includes('Третья строка'));
    await page.click('#tech-ai-assistant-drawer button[title^="Закрыть"]');
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer textarea')?.value.includes('Третья строка'));
    await page.click('[data-testid="tech-ai-expand"]');
    assert.equal(await page.$eval('#tech-ai-assistant-drawer', (node) => node.getBoundingClientRect().width), 1280);
    await page.click('[data-testid="tech-ai-expand"]');
    assert.equal(await page.$eval('#tech-ai-assistant-drawer', (node) => node.getBoundingClientRect().width), 640);
    await page.evaluate(() => {
      const node = document.querySelector('#tech-ai-assistant-drawer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, 'Проверка прокрутки');
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find((node) => node.textContent === 'Отправить').click());
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
    await page.$eval('[data-testid="tech-ai-send-preview"] button', (node) => node.click());
    await page.waitForFunction(() => {
      const history = document.querySelector('[data-testid="tech-ai-history"]');
      return history?.textContent.includes('Строка потокового ответа 25') && history.scrollHeight > history.clientHeight;
    });
    await page.$eval('[data-testid="tech-ai-history"]', (node) => { node.scrollTop = 0; });
    await page.waitForSelector('[data-testid="tech-ai-latest"]');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await page.$eval('[data-testid="tech-ai-history"]', (node) => node.scrollTop), 0);
    await page.click('[data-testid="tech-ai-latest"]');
    await page.waitForFunction(() => !document.querySelector('#tech-ai-assistant-drawer textarea').disabled);
    const checkLayout = async () => page.evaluate(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
      const composer = document.querySelector('#tech-ai-assistant-drawer textarea').getBoundingClientRect();
      const close = document.querySelector('#tech-ai-assistant-drawer button[title^="Закрыть"]').getBoundingClientRect();
      const history = document.querySelector('[data-testid="tech-ai-history"]');
      return { inside: drawer.left >= 0 && drawer.right <= innerWidth && composer.bottom <= innerHeight && close.right <= innerWidth, history: history.clientHeight, screen: innerHeight };
    });
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 650 }, { width: 360, height: 740 }]) {
      await page.setViewport(viewport);
      const layout = await checkLayout();
      assert.ok(layout.inside && layout.history > layout.screen * .45, JSON.stringify({ viewport, ...layout }));
    }
    await page.setViewport({ width: 1280, height: 650 });
    await page.screenshot({ path: '/test-results/assistant-080-dark.png' });
    await page.evaluate(async () => {
      const save = await fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
      if (!save.ok) throw new Error(`Light theme: ${save.status}`);
    });
    await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher');
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    const light = await page.$eval('#tech-ai-assistant-drawer', (node) => getComputedStyle(node).backgroundColor);
    assert.ok(light === 'rgb(255, 255, 255)' || light === 'rgb(244, 245, 245)', light);
    assert.ok((await checkLayout()).inside);
    await page.screenshot({ path: '/test-results/assistant-080-light.png' });
    console.log('ux-test=ok; draft, fullscreen, manual stream scroll, desktop/mobile, light/dark');
  } finally {
    if (settings) await page.evaluate((settings) => fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }), settings);
    if (preferences) await page.evaluate((preferences) => fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) }), preferences);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
