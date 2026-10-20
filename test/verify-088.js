const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-088-${Date.now().toString(36)}`;
const from = Date.UTC(2026, 9, 14, 9), to = from + 3600000;
const answer = '## Результат\n\nCPU показывает загрузку сервера.\n\n' + 'Пояснение для проверки прокрутки и длинного ответа.\n\n'.repeat(20);
function contextOf(body) {
  for (const message of body.messages) {
    const text = typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    const match = /Файл: grafana-context.json\n```json\n([\s\S]*?)\n```/.exec(text) || /Текущий контекст Grafana:\n([\s\S]+)$/.exec(text);
    if (match) return JSON.parse(match[1]);
  }
  throw new Error('Missing context');
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [], requests = [], configWrites = [];
  let originalSettings, preferences, created = false, datasourceCalls = 0, failNext = false, stage = 'login';
  let mockSettings = { provider: 'custom', model: 'UI mock', apiUrl: 'http://unused', apiPath: '/v1/chat/completions', launcherMode: 'both', streaming: false, previewBeforeSend: 'always', contextTokens: 8192, includePanelData: true, screenshotEnabled: true };
  try {
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 650 });
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (originalSettings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) {
        if (request.method() === 'POST') { configWrites.push(JSON.parse(request.postData())); mockSettings = configWrites.at(-1).jsonData; return request.respond({ status: 200, contentType: 'application/json', body: '{}' }); }
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...originalSettings, enabled: true, jsonData: mockSettings }) });
      }
      if (path.endsWith('/api/ds/query') && request.method() === 'POST') {
        datasourceCalls++;
        const body = JSON.parse(request.postData());
        const results = Object.fromEntries(body.queries.map(query => [query.refId || 'A', { status: 200, frames: [{ schema: { refId: query.refId || 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'CPU', type: 'number', config: { unit: 'percent' } }] }, data: { values: [[from, from + 1800000, to], [10, 80, 25]] } }] }]));
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
      }
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        requests.push(JSON.parse(request.postData()));
        const failed = failNext; failNext = false;
        return request.respond({ status: failed ? 502 : 200, contentType: 'application/json', body: JSON.stringify(failed ? { error: { message: 'Test upstream timeout' } } : { choices: [{ message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }) });
      }
      return request.continue();
    });
    await page.goto(`${root}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => { const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!response.ok) throw new Error('Login failed'); });
    originalSettings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    preferences = await page.evaluate(async () => (await fetch('/crf/dashboard/api/user/preferences')).json());
    await page.evaluate(async ({ uid, from, to }) => {
      const dashboard = { uid, title: 'Tech AI UI test', schemaVersion: 42, timezone: 'utc', panels: [{ id: 1, title: 'CPU', type: 'timeseries', targets: [{ refId: 'A', expr: '{service_name="keycloak"}', datasource: { type: 'loki', uid: 'loki' } }], datasource: { type: 'loki', uid: 'loki' }, gridPos: { x: 0, y: 0, w: 24, h: 8 }, fieldConfig: { defaults: {}, overrides: [] } }, { id: 2, title: 'Notes', type: 'text', targets: [], options: { content: 'Demo', mode: 'markdown' }, gridPos: { x: 0, y: 8, w: 24, h: 4 } }], time: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard, overwrite: false }) }); if (!response.ok) throw new Error('Create dashboard failed');
    }, { uid, from, to }); created = true;
    const dashboardUrl = `${root}/d/${uid}/ui-test?from=${from}&to=${to}&timezone=utc`;
    const click = async label => page.evaluate(label => { const button = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === label); if (!button) throw new Error(`Missing ${label}`); button.click(); }, label);
    const ask = async (text, mode) => {
      await page.waitForSelector('#tech-ai-assistant-drawer .tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
      await page.select('[data-testid="tech-ai-composer-data-mode"]', mode);
      await page.type('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"] textarea', text);
      await click('Отправить'); await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
      await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
      await page.waitForSelector('#tech-ai-assistant-drawer .tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
    };
    await page.goto(dashboardUrl, { waitUntil: 'networkidle2' }); await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer .tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
    stage = 'data modes and search';
    await ask('Explain CPU', 'sample'); assert.ok(contextOf(requests.at(-1)).panelData);
    assert.match(await page.$eval('[data-testid="tech-ai-sent-context"] summary', node => node.textContent), /Данные 1\/1/);
    const calls = datasourceCalls;
    await ask('Use previous results', 'snapshot'); assert.equal(datasourceCalls, calls); assert.ok(contextOf(requests.at(-1)).panelData);
    await ask('Explain only the JSON', 'structure'); assert.equal(datasourceCalls, calls); assert.equal(contextOf(requests.at(-1)).panelData, undefined);
    await page.click('[data-testid="tech-ai-tab-context"]'); await page.type('[data-testid="tech-ai-panel-filter"]', '#2');
    assert.match(await page.$eval('[data-testid="tech-ai-context-tab"]', node => node.textContent), /Notes.*без доступных запросов/s);
    assert.equal(await page.$$eval('[data-testid="tech-ai-context-tab"] input[type="checkbox"]', nodes => nodes.length), 2);
    assert.match(await page.$eval('[data-testid="tech-ai-panel-summary"]', node => node.textContent), /2 из 2/);
    await page.click('[data-testid="tech-ai-tab-chat"]');
    stage = 'single-use screenshot and retry';
    await page.evaluate(() => {
      window.captureCalls = 0;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: async () => { window.captureCalls++; const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; canvas.getContext('2d').fillRect(0, 0, 320, 180); return canvas.captureStream(5); } } });
    });
    await page.click('[data-testid="tech-ai-screenshot-toggle"]'); failNext = true;
    await ask('Look at the picture', 'structure'); await page.waitForSelector('[data-testid="tech-ai-error"]');
    const image = requests.at(-1).messages.at(-1).content.find(part => part.type === 'image_url').image_url.url;
    assert.equal(await page.evaluate(() => window.captureCalls), 1);
    await click('Повторить'); await page.waitForSelector('#tech-ai-assistant-drawer .tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
    assert.equal(requests.at(-1).messages.at(-1).content.find(part => part.type === 'image_url').image_url.url, image);
    assert.equal(await page.evaluate(() => window.captureCalls), 1);
    assert.equal(await page.$eval('[data-testid="tech-ai-screenshot-toggle"]', node => node.getAttribute('aria-pressed')), 'false');
    assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes('data:image/jpeg;base64'));
    stage = 'responsive controls and manual resize';
    await page.evaluate(() => { const area = document.querySelector('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"] textarea'); area.value = ''; area.dispatchEvent(new Event('input', { bubbles: true })); });
    const area = await page.$('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"] textarea'); const box = await area.boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4); await page.mouse.down(); await page.mouse.move(box.x + box.width - 4, box.y + box.height + 55, { steps: 8 }); await page.mouse.up();
    const resized = await area.evaluate(node => node.getBoundingClientRect().height); await page.type('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"] textarea', 'Text after resize');
    assert.ok(await area.evaluate((node, height) => node.getBoundingClientRect().height >= height - 2, resized));
    for (const width of [1280, 380, 360]) {
      await page.setViewport({ width, height: width === 1280 ? 650 : 740 });
      if (width === 380) await page.$eval('#tech-ai-assistant-drawer', node => { node.style.width = '380px'; });
      const layout = await page.evaluate(() => { const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect(), composer = document.querySelector('[data-testid="tech-ai-composer"]').getBoundingClientRect(), history = document.querySelector('[data-testid="tech-ai-history"]'); return { inside: drawer.left >= 0 && drawer.right <= innerWidth && composer.right <= innerWidth && composer.bottom <= innerHeight, history: history.clientHeight, overflow: composer.width < document.querySelector('[data-testid="tech-ai-composer"]').scrollWidth - 2 }; });
      assert.ok(layout.inside && layout.history > 100 && !layout.overflow, JSON.stringify(layout));
      await page.$eval('[data-testid="tech-ai-history"]', node => { node.scrollTop = node.scrollHeight; });
      await page.screenshot({ path: `/test-results/assistant-088-${width}.png` });
    }
    stage = 'configuration'; await page.setViewport({ width: 1280, height: 740 });
    await page.goto(`${root}/plugins/tech-ai-assistant-app?page=configuration`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="tech-ai-config-save-bar"]');
    assert.equal(await page.$$eval('.tech-ai-config section', nodes => nodes.length), 4);
    assert.equal(await page.$eval('[data-testid="tech-ai-config-save-bar"] button', node => node.disabled), true);
    await page.$eval('.tech-ai-config input[type="number"]', node => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(node, '16384'); node.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForSelector('[data-testid="tech-ai-config-save-bar"] button:not([disabled])');
    await page.$eval('[data-testid="tech-ai-config-save-bar"] button', node => node.click());
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-config-save-bar"]').textContent.includes('Сохранено'));
    assert.equal(configWrites.length, 1); assert.equal(configWrites[0].jsonData.contextTokens, 16384);
    await page.$eval('.tech-ai-config section:nth-of-type(2)', node => node.scrollIntoView({ block: 'start' }));
    assert.ok(await page.$eval('[data-testid="tech-ai-config-save-bar"]', node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
    await page.screenshot({ path: '/test-results/assistant-088-config.png' });
    stage = 'full page';
    await page.goto(`${root}/a/tech-ai-assistant-app?dashboardUid=${uid}&from=${from}&to=${to}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="tech-ai-composer"]');
    assert.ok(await page.$eval('[data-testid="tech-ai-composer"]', node => { const box = node.getBoundingClientRect(); return box.right <= innerWidth && box.bottom <= innerHeight; }));
    await page.screenshot({ path: '/test-results/assistant-088-page.png' });
    stage = 'panel menu drawer';
    await page.goto(dashboardUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="data-testid Panel header CPU"]');
    await page.hover('[data-testid="data-testid Panel header CPU"]');
    await page.evaluate(() => {
      const header = document.querySelector('[data-testid="data-testid Panel header CPU"]');
      const panel = document.querySelector('[data-griditem-key="grid-item-1"]') || header.closest('.react-grid-item') || header.closest('section') || header.parentElement;
      const buttons = [...panel.querySelectorAll('button')];
      const menu = buttons.find(node => /menu/i.test([node.getAttribute('aria-label'), node.getAttribute('data-testid'), node.title].join(' ')));
      if (!menu) throw new Error('No panel menu: ' + buttons.map(node => node.getAttribute('aria-label') || node.getAttribute('data-testid') || node.textContent).join(','));
      menu.click();
    });
    const extensions = await page.evaluateHandle(() => [...document.querySelectorAll('a,button,[role="menuitem"],span')].find(node => node.textContent.trim() === 'Extensions'));
    assert.ok(extensions.asElement(), 'Missing Extensions submenu');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await extensions.asElement().hover();
    if (!(await page.waitForFunction(() => [...document.querySelectorAll('a,button,[role="menuitem"]')].some(node => node.textContent.trim() === 'Спросить AI'), { timeout: 1500 }).then(() => true).catch(() => false))) {
      await extensions.asElement().click();
    }
    await page.waitForFunction(() => [...document.querySelectorAll('a,button,[role="menuitem"]')].some(node => node.textContent.trim() === 'Спросить AI'));
    await page.evaluate(() => [...document.querySelectorAll('a,button,[role="menuitem"]')].find(node => node.textContent.trim() === 'Спросить AI').click());
    await page.waitForSelector('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"]');
    assert.ok(await page.$eval('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"]', node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; }));
    await page.screenshot({ path: '/test-results/assistant-088-modal.png' });
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-088-test=ok; composer data modes, no hidden queries, panel filter, screenshot retry/single use/no history base64, resize, desktop/narrow/mobile, grouped configuration/sticky save, full page and common panel drawer; real Grafana, mock model/data/capture');
  } catch (error) { console.error(`release-088-test stage=${stage}`); if (!page.isClosed()) await page.screenshot({ path: '/test-results/assistant-088-failure.png' }).catch(() => {}); throw error; }
  finally {
    try {
      if (preferences && !page.isClosed()) await page.evaluate(preferences => fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) }), preferences);
      if (created && !page.isClosed()) await page.evaluate(async uid => { const response = await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' }); if (!response.ok) throw new Error('Cleanup failed'); }, uid);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
