const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-092-${Date.now().toString(36)}`;
const from = Date.UTC(2026, 9, 14, 9), to = from + 3600000;
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const requests = [], errors = [];
  let originalSettings, created = false, delay = 0, stage = 'login';
  const settings = { provider: 'custom', model: 'UI mock', streaming: false, launcherMode: 'both', previewBeforeSend: 'always', contextTokens: 16384, includePanelData: true, explainSamplePanels: 1 };
  try {
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 750 });
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const respond = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (originalSettings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return respond({ ...originalSettings, jsonData: settings });
      if (path.endsWith('/api/ds/query') && request.method() === 'POST') {
        const body = JSON.parse(request.postData());
        return respond({ results: Object.fromEntries(body.queries.map(query => [query.refId, { status: 200, frames: [{ schema: { refId: query.refId, meta: { executedQueryString: query.expr }, fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] }, data: { values: [[Number(body.from), Number(body.to)], [10, 20]] } }] }])) });
      }
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        requests.push(JSON.parse(request.postData()));
        const result = { choices: [{ message: { content: '## Результат\n\n' + 'Данные получены, ограничения указаны в составе отправки.\n\n'.repeat(12) } }] };
        if (delay) return setTimeout(() => respond(result), delay);
        return respond(result);
      }
      return request.continue();
    });
    await page.goto(`${root}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => { const r = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!r.ok) throw new Error('Login failed'); });
    originalSettings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    await page.evaluate(async ({ uid, from, to }) => {
      const panels = [1, 2, 3].map((id, index) => ({ id, title: ['CPU', 'RAM', 'Errors'][index], type: 'timeseries', datasource: { uid: 'loki', type: 'loki' }, targets: [{ refId: 'A', expr: '{service_name="keycloak"}', datasource: { uid: 'loki', type: 'loki' } }], gridPos: { x: 0, y: index * 5, w: 24, h: 5 }, fieldConfig: { defaults: {}, overrides: [] } }));
      const r = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: { uid, title: 'Tech AI usability test', schemaVersion: 42, timezone: 'utc', panels, time: { from: String(from), to: String(to) } }, overwrite: false }) });
      if (!r.ok) throw new Error('Create failed');
    }, { uid, from, to }); created = true;
    const click = text => page.evaluate(text => { const node = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === text); if (!node) throw new Error('Missing ' + text); node.click(); }, text);
    const ready = () => page.waitForSelector('#tech-ai-assistant-drawer .tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
    const ask = async (text, mode) => {
      await page.select('[data-testid="tech-ai-composer-data-mode"]', mode);
      await page.type('[data-testid="tech-ai-composer"] textarea', text);
      await click('Отправить'); await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
      await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
      await ready();
    };
    await page.goto(`${root}/d/${uid}/usability?from=${from}&to=${to}&timezone=utc&var-region=west`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher'); await ready();
    stage = 'inline panel choice';
    assert.equal(await page.$('[data-testid="tech-ai-context-popover"]'), null);
    await page.type('[data-testid="tech-ai-composer"] textarea', 'Unrelated draft');
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="tech-ai-welcome"] strong')].find(node => node.textContent === 'Помочь с запросом').closest('button').click());
    await page.waitForSelector('[data-testid="tech-ai-context-popover"]');
    assert.equal(requests.length, 0); assert.equal(await page.$('[data-testid="tech-ai-error"]'), null);
    await page.click('[data-testid="tech-ai-chat-panel"][data-panel-id="2"]');
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
    assert.equal(requests.length, 0);
    assert.equal(await page.$eval('[data-testid="tech-ai-tab-chat"]', node => node.getAttribute('aria-selected')), 'true');
    await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click()); await ready();
    assert.equal(await page.$eval('[data-testid="tech-ai-composer"] textarea', node => node.value), 'Unrelated draft');
    await page.click('[data-testid="tech-ai-scope-chip"]'); await click('Выбрать все панели');
    await page.click('[data-testid="tech-ai-composer"] textarea'); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
    stage = 'per-turn limits and immutable context';
    await ask('Объясни выбранные панели', 'sample');
    const captions = await page.$$('[data-testid="tech-ai-sent-context"]');
    const sent = captions.at(-1);
    assert.equal(await sent.evaluate(node => node.open), false);
    assert.ok((await sent.evaluate(node => node.querySelector('summary').textContent)).includes('Данные 1/3 · 2 пропущено'));
    await sent.evaluate(node => { node.open = true; });
    const originalDetails = await sent.evaluate(node => node.querySelector('[data-testid="tech-ai-sent-context-details"]').textContent);
    assert.ok(originalDetails.includes('лимит 1 панелей'));
    await sent.evaluate(node => { node.open = false; });
    const historyHeight = await page.$eval('[data-testid="tech-ai-history"]', node => node.clientHeight);
    const countBeforeChange = requests.length;
    await page.evaluate(({ from, to }) => { const url = new URL(location.href); url.searchParams.set('from', String(from)); url.searchParams.set('to', String(to)); url.searchParams.set('var-region', 'east'); history.replaceState(history.state, '', url); }, { from: from + 3600000, to: to + 3600000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-period-chip"]').classList.contains('tech-ai-context-changed'));
    assert.equal(requests.length, countBeforeChange);
    assert.equal(await sent.evaluate(node => node.querySelector('[data-testid="tech-ai-sent-context-details"]').textContent), originalDetails);
    assert.equal(await page.$eval('[data-testid="tech-ai-history"]', node => node.clientHeight), historyHeight);
    await page.click('[data-testid="tech-ai-period-chip"]');
    await page.waitForSelector('[data-testid="tech-ai-context-change-details"]');
    const change = await page.$eval('[data-testid="tech-ai-context-change-details"]', node => node.textContent);
    assert.ok(change.includes('период') && change.includes('переменные') && change.includes('east'));
    await page.keyboard.press('Escape');
    assert.ok(await page.$('#tech-ai-assistant-drawer')); assert.equal(await page.$('[data-testid="tech-ai-context-popover"]'), null);
    stage = 'draft during slow answer';
    delay = 2500;
    await page.select('[data-testid="tech-ai-composer-data-mode"]', 'structure');
    await page.type('[data-testid="tech-ai-composer"] textarea', 'Slow question'); await click('Отправить');
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]'); await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
    await page.waitForSelector('.tech-ai-root[data-busy="true"]');
    assert.equal(await page.$eval('[data-testid="tech-ai-composer"] textarea', node => node.disabled), false);
    await page.type('[data-testid="tech-ai-composer"] textarea', 'Next draft'); await page.keyboard.press('Enter');
    await ready();
    assert.equal(requests.length, countBeforeChange + 1);
    assert.equal(await page.$eval('[data-testid="tech-ai-composer"] textarea', node => node.value), 'Next draft\n');
    stage = 'desktop/mobile no permanent extra space';
    for (const width of [1280, 360]) {
      await page.setViewport({ width, height: width === 1280 ? 750 : 740 });
      await page.click('[data-testid="tech-ai-scope-chip"]');
      const layout = await page.$eval('[data-testid="tech-ai-context-popover"]', node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
      assert.ok(layout.left >= 0 && layout.right <= layout.width + 1 && layout.bottom <= layout.height, JSON.stringify(layout));
      await page.screenshot({ path: `/test-results/assistant-092-context-${width}.png` });
      await page.keyboard.press('Escape');
      assert.ok(await page.$eval('[data-testid="tech-ai-history"]', node => node.clientHeight > 150));
    }
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-092-test=ok; real Grafana 13 UI/mock model+data; inline panel choice without requests/errors, unrelated draft retained, actual per-turn limits, immutable period/data scope, context change without extra chat space/network, safe draft during response, desktop/mobile popover and Escape');
  } catch (error) { console.error('release-092 stage=' + stage); await page.screenshot({ path: '/test-results/assistant-092-failure.png' }).catch(() => {}); throw error; }
  finally {
    try { if (created) await page.evaluate(async uid => { const r = await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' }); if (!r.ok) throw new Error('Cleanup failed'); }, uid); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
