const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const base = process.env.GRAFANA_DIAG_URL || 'http://localhost:3300/crf/dashboard';
const expectBroken = process.env.GRAFANA_EXPECT_BROKEN === '1';
(async () => {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Grafana must become ready');
  const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  let modelCalls = 0;
  let originalSettings;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        modelCalls++;
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'REACT COMPATIBILITY VERIFIED' } }] }) });
      }
      return request.continue();
    });
    await page.goto(base + '/login');
    originalSettings = await page.evaluate(async base => {
      const prefix = new URL(base).pathname;
      const response = await fetch(prefix + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!response.ok) throw new Error('Login failed');
      const original = await (await fetch(prefix + '/api/plugins/tech-ai-assistant-app/settings')).json();
      const enabled = await fetch(prefix + '/api/plugins/tech-ai-assistant-app/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, jsonData: { launcherMode: 'both', provider: 'custom', model: 'Compatibility test', streaming: false, includePanelData: false, previewBeforeSend: 'always', useAuth: false, apiUrl: 'http://unused.invalid', apiPath: '/v1/chat/completions' } }) });
      if (!enabled.ok) throw new Error('Enable failed: ' + await enabled.text());
      return original;
    }, base);
    await page.goto(base + '/', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#tech-ai-assistant-launcher');
    const before = await page.evaluate(async base => {
      const health = await (await fetch(new URL(base).pathname + '/api/health')).json();
      const result = { version: health.version, system: typeof window.System };
      if (window.System) {
        const dom = await window.System.import('react-dom');
        const client = await window.System.import('react-dom/client');
        result.reactDom = { render: typeof dom.render, createRoot: typeof dom.createRoot };
        result.client = { createRoot: typeof client.createRoot };
      }
      return result;
    }, base);
    await page.click('#tech-ai-assistant-launcher');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const after = await page.evaluate(() => ({ drawer: Boolean(document.querySelector('#tech-ai-assistant-drawer')), assistant: Boolean(document.querySelector('.tech-ai-root')), url: location.href }));
    await page.screenshot({ path: process.env.GRAFANA_DIAG_SCREENSHOT || 'test-results/grafana-1322-opening-after.png' });
    console.log(JSON.stringify({ before, after, errors }, null, 2));
    assert.equal(before.version, process.env.GRAFANA_EXPECT_VERSION || '13.2.2');
    assert.equal(after.drawer, !expectBroken);
    assert.equal(after.assistant, !expectBroken);
    if (!expectBroken) {
      const area = '#tech-ai-assistant-drawer .tech-ai-root[data-busy="false"] textarea:not([disabled])';
      await page.waitForSelector(area);
      await page.type(area, 'Проверь совместимость');
      await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(button => button.textContent.trim() === 'Отправить').click());
      await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
      await page.$eval('[data-testid="tech-ai-send-preview"] button', button => button.click());
      await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').textContent.includes('REACT COMPATIBILITY VERIFIED'));
      assert.equal(modelCalls, 1);
      await page.click('#tech-ai-assistant-drawer button[title="Закрыть (Esc)"]');
      assert.equal(await page.$('#tech-ai-assistant-drawer'), null);
      await page.click('#tech-ai-assistant-launcher');
      await page.waitForSelector(area);
      assert.equal(await page.$$eval('#tech-ai-assistant-drawer', nodes => nodes.length), 1);
      await page.setViewport({ width: 360, height: 740 });
      const bounds = await page.$eval('#tech-ai-assistant-drawer button[title="Закрыть (Esc)"]', node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right }; });
      assert.ok(bounds.x >= 0 && bounds.right <= 360);
      await page.screenshot({ path: 'test-results/grafana-opening-mobile.png' });
      assert.deepEqual(errors, []);
      console.log('PASS: real Grafana ' + before.version + '; drawer, mocked chat response, close/reopen, 360px close button; no page errors');
    }
  } finally {
    try {
      if (originalSettings) await page.evaluate(async ({ base, original }) => {
        const response = await fetch(new URL(base).pathname + '/api/plugins/tech-ai-assistant-app/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: original.enabled, pinned: original.pinned, jsonData: original.jsonData || {} }) });
        if (!response.ok) throw new Error('Restore settings failed');
      }, { base, original: originalSettings });
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
