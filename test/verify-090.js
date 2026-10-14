const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-090-${Date.now().toString(36)}`;
const from = Date.UTC(2026, 9, 14, 9), to = from + 3600000;
function contextOf(body) {
  const content = body.messages[0].content;
  const marker = '\n\nТекущий контекст Grafana:\n';
  return JSON.parse(content.slice(content.indexOf(marker) + marker.length));
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [], requests = [], datasource = [], metadata = [], annotationWrites = [];
  let originalSettings, created = false, stage = 'login', mode = 'proposal', schemaRequested = false;
  const settings = { provider: 'custom', model: 'UI mock', streaming: false, launcherMode: 'both', previewBeforeSend: 'always', includePanelData: true, screenshotEnabled: true, schemaDiscoveryEnabled: true, investigationEventsEnabled: true, contextTokens: 16384 };
  const answer = '## CPU\n\nПроверенная сводка данных.\n\n' + 'Пояснение для проверки прокрутки.\n\n'.repeat(12);
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
        const body = JSON.parse(request.postData()); datasource.push(body);
        const times = [Number(body.from), (Number(body.from) + Number(body.to)) / 2, Number(body.to)];
        return respond({ results: Object.fromEntries(body.queries.map(query => [query.refId, { status: 200, frames: [{ schema: { refId: query.refId, meta: { executedQueryString: query.expr, preferredVisualisationType: 'graph' }, fields: [{ name: 'Time', type: 'time' }, { name: 'CPU', type: 'number', config: { unit: 'percent' } }] }, data: { values: [times, [10, 80, 25]] } }] }])) });
      }
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        const body = JSON.parse(request.postData()); requests.push(body);
        let content = answer;
        if (mode === 'proposal') content += '\n```dashboard-json\n{"panelId":1,"targets":[{"refId":"A","expr":"{service_name=\\"keycloak\\"}"}]}\n```';
        if (mode === 'investigate' && !schemaRequested) { schemaRequested = true; content = '```grafana-schema\n{"datasourceUid":"loki","action":"labels","reason":"Проверить имена labels"}\n```'; }
        return respond({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 80 } });
      }
      if (path.includes('/api/datasources/proxy/uid/loki/loki/api/v1/labels')) { metadata.push(request.url()); return respond({ status: 'success', data: ['service_name', 'level'] }); }
      if (path.endsWith('/api/annotations') && request.method() === 'POST') { annotationWrites.push(JSON.parse(request.postData())); return respond({ id: 42, message: 'Annotation added' }); }
      if (path.endsWith('/api/annotations') && request.method() === 'GET') { metadata.push(request.url()); return respond([{ time: from + 1800000, panelId: 1, text: 'Deployment', tags: ['deploy'] }]); }
      if (path.includes(`/api/dashboards/uid/${uid}/versions`)) {
        metadata.push(request.url());
        return respond(path.endsWith('/versions') ? [{ version: 1 }, { version: 0 }] : { data: { panels: [{ id: 1, title: 'CPU', targets: [{ refId: 'A', expr: '{previous="true"}' }] }] } });
      }
      return request.continue();
    });
    await page.goto(`${root}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!response.ok) throw new Error('Login failed');
    });
    originalSettings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    await page.evaluate(async ({ uid, from, to }) => {
      const dashboard = { uid, title: 'Tech AI feature test', schemaVersion: 42, timezone: 'utc', panels: [{ id: 1, title: 'CPU', type: 'timeseries', datasource: { uid: 'loki', type: 'loki' }, targets: [{ refId: 'A', expr: '{service_name="keycloak"}', datasource: { uid: 'loki', type: 'loki' } }], gridPos: { x: 0, y: 0, w: 24, h: 8 }, fieldConfig: { defaults: {}, overrides: [] } }, { id: 2, title: 'Notes', type: 'text', targets: [], options: { content: 'Notes', mode: 'markdown' }, gridPos: { x: 0, y: 8, w: 24, h: 4 } }], time: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard, overwrite: false }) });
      if (!response.ok) throw new Error('Create failed');
    }, { uid, from, to }); created = true;
    const click = label => page.evaluate(label => { const node = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === label); if (!node) throw new Error('Missing ' + label); node.click(); }, label);
    const ask = async (text, dataMode) => {
      const count = requests.length;
      await page.select('[data-testid="tech-ai-composer-data-mode"]', dataMode);
      await page.type('[data-testid="tech-ai-composer"] textarea', text);
      await click('Отправить');
      await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
      await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
      await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
      assert.ok(requests.length > count);
    };
    await page.goto(`${root}/d/${uid}/features?from=${from}&to=${to}&timezone=utc`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    metadata.length = 0;
    stage = 'manual validation';
    await ask('Объясни CPU', 'sample');
    assert.equal(metadata.length, 0, 'Ordinary question must not read metadata');
    assert.equal(requests.length, 1, 'Proposal must not self-repair automatically');
    const beforeCheck = datasource.length;
    await page.click('[data-testid="tech-ai-validate-proposal"]');
    await page.waitForSelector('[data-testid="tech-ai-validation-result"]');
    assert.equal(datasource.length, beforeCheck + 1);
    assert.equal(Number(datasource.at(-1).from), from); assert.equal(Number(datasource.at(-1).to), to);
    assert.equal(requests.length, 1);
    stage = 'peak and opt-in metadata/schema';
    await page.$eval('[data-testid="tech-ai-answer-charts"]', node => { node.open = true; node.dispatchEvent(new Event('toggle')); });
    await page.waitForSelector('[data-testid="tech-ai-investigate-peak"]');
    const beforePeak = datasource.length;
    await page.click('[data-testid="tech-ai-investigate-peak"]');
    await page.waitForSelector('[data-testid="tech-ai-investigation-setup"]');
    assert.equal(datasource.length, beforePeak);
    assert.equal(await page.$eval('[data-testid="tech-ai-peak-before"]', node => Number(node.value)), 60);
    assert.equal(await page.$eval('[data-testid="tech-ai-peak-after"]', node => Number(node.value)), 30);
    for (const [selector, value] of [['[data-testid="tech-ai-peak-before"]', '10'], ['[data-testid="tech-ai-peak-after"]', '5']]) {
      await page.click(selector, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(selector, value);
    }
    assert.equal(datasource.length, beforePeak);
    await page.evaluate(() => { const label = [...document.querySelectorAll('[data-testid="tech-ai-investigation-setup"] label')].find(node => node.textContent.includes('дополнительные read-only')); label.querySelector('input').click(); });
    await page.waitForSelector('[data-testid="tech-ai-allow-schema"]');
    await page.click('[data-testid="tech-ai-allow-schema"]'); await page.click('[data-testid="tech-ai-include-annotations"]'); await page.click('[data-testid="tech-ai-include-versions"]');
    mode = 'investigate';
    await click('Начать расследование');
    await page.waitForFunction(() => !document.querySelector('[data-testid="tech-ai-composer"] textarea').disabled && document.querySelectorAll('[data-testid="tech-ai-answer"]').length >= 2);
    const investigation = contextOf(requests.at(-1));
    assert.equal(Number(investigation.timeRange.from), from + 1200000);
    assert.equal(Number(investigation.timeRange.to), from + 2100000);
    assert.equal(investigation.annotations[0].text, 'Deployment');
    assert.equal(investigation.versionChanges.previousVersion, 0);
    assert.ok(metadata.some(url => url.includes('/loki/api/v1/labels')));
    assert.ok(requests.at(-1).messages.some(message => typeof message.content === 'string' && message.content.includes('service_name') && message.content.includes('Результаты запросов')));
    stage = 'annotation draft';
    await page.click('[data-testid="tech-ai-annotation-draft"]');
    await page.waitForSelector('[data-testid="tech-ai-annotation-form"]');
    assert.equal(annotationWrites.length, 0);
    await page.click('[data-testid="tech-ai-save-annotation"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-annotation-form"]').textContent.includes('Аннотация сохранена'));
    assert.equal(annotationWrites.length, 1); assert.equal(annotationWrites[0].dashboardUID, uid);
    await page.$eval('[data-testid="tech-ai-annotation-form"]', node => [...node.querySelectorAll('button')].find(button => button.textContent === 'Закрыть').click());
    stage = 'canvas coverage';
    await click('Новый диалог');
    await page.evaluate(() => {
      const panel = document.querySelector('[data-griditem-key="grid-item-1"]') || document.querySelector('[data-testid="data-testid Panel header CPU"]').closest('section');
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 100; canvas.style.cssText = 'width:400px;height:100px;position:absolute;left:20px;top:60px';
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#5794f2'; ctx.fillRect(0, 0, 400, 100); panel.appendChild(canvas);
    });
    await page.click('[data-testid="tech-ai-tab-context"]');
    await page.select('[data-testid="tech-ai-capture-mode"]', 'canvas');
    await page.click('[data-testid="tech-ai-tab-chat"]');
    await page.click('[data-testid="tech-ai-screenshot-toggle"]'); mode = 'explain';
    await ask('Посмотри график', 'structure');
    const image = requests.at(-1).messages.at(-1).content.find(part => part.type === 'image_url');
    assert.ok(image.image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.ok(await page.$eval('[data-testid="tech-ai-user-turn"]', node => node.textContent.includes('Canvas: 1 панелей; пропущено 1')));
    assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes('data:image/jpeg;base64,'));
    await page.screenshot({ path: '/test-results/assistant-090-canvas.png' });
    stage = 'Explore current context';
    await page.evaluate(() => document.querySelector('#tech-ai-assistant-drawer button[title="Закрыть (Esc)"]').click());
    const panes = { a: { datasource: 'loki', queries: [{ refId: 'A', expr: '{service_name="keycloak"}' }], range: { from: String(from), to: String(to) } } };
    await page.goto(`${root}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}&orgId=1`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    await ask('Объясни запрос Explore', 'structure');
    const explore = contextOf(requests.at(-1));
    assert.equal(explore.isExplore, true); assert.equal(explore.panels[0].targets[0].expr, '{service_name="keycloak"}');
    assert.equal(explore.panels[0].targets[0].datasource.type, 'loki');
    assert.ok(!errors.length, errors.join('\n'));
    await page.screenshot({ path: '/test-results/assistant-090-explore.png' });
    console.log('release-090-test=ok; real Grafana 13 UI, mock model/data/metadata; no automatic validation, explicit validation, peak confirmation/narrow period, opt-in events/schema and tool rounds, explicit annotation save, Canvas coverage/no image in storage, Explore context');
  } catch (error) { console.error('release-090 stage=' + stage); await page.screenshot({ path: '/test-results/assistant-090-failure.png' }).catch(() => {}); throw error; }
  finally {
    try { if (created) await page.evaluate(async uid => { const response = await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' }); if (!response.ok) throw new Error('Cleanup failed'); }, uid); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
