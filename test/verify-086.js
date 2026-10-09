const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');

const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-086-${Date.now().toString(36)}`;
const title = 'Requests per pod';
const from = Date.UTC(2026, 9, 7, 9);
const to = from + 3600000;
const times = [2, 12, 22, 32, 55].map(minute => from + minute * 60000);
const answer = `## Нагрузка\n\nПанель ${title} показывает восемь pod. У api-6 максимум 95 запросов в секунду.\n\n` + 'Пояснение для проверки прокрутки: сравните пик с соседними точками и журналом событий.\n\n'.repeat(15);
let frameUnit, valuesScale = 1;

function frame(refId) {
  return {
    schema: { refId, fields: [{ name: 'Time', type: 'time' }].concat(Array.from({ length: 8 }, (_, index) => ({
      name: 'Value', type: 'number', labels: { pod: `api-${index}` }, config: frameUnit ? { unit: frameUnit } : undefined,
    }))) },
    data: { values: [times].concat(Array.from({ length: 8 }, (_, index) => index === 6
      ? [10, 95, null, 12, 19]
      : [10 + index, 15 + index, 18 + index, 13 + index, 20 + index]).map(values => values.map(value => value === null ? null : value * valuesScale))) },
  };
}

function contextOf(body) {
  const texts = body.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'text').map(part => part.text)
    : [message.content || '']);
  for (const text of texts) {
    const file = /Файл: grafana-context.json\n```json\n([\s\S]*?)\n```/.exec(text);
    if (file) return JSON.parse(file[1]);
    const inline = /Текущий контекст Grafana:\n([\s\S]+)$/.exec(text);
    if (inline) return JSON.parse(inline[1]);
  }
  throw new Error('Missing Grafana context');
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [], requests = [];
  let settings, created = false, datasourceCalls = 0, stage = 'login';
  try {
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 650 });
    await page.emulateTimezone('Europe/Moscow');
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (settings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method() === 'GET') {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...settings, enabled: true, jsonData: {
          provider: 'custom', model: 'UI 086 mock', apiUrl: 'http://unused', apiPath: '/v1/chat/completions',
          launcherMode: 'both', includePanelData: true, streaming: false, previewBeforeSend: 'always',
          answerCharts: true, maxSeriesPerQuery: 8, explainSampleRows: 3, contextTokens: 8192,
        } }) });
      }
      if (path.endsWith('/api/ds/query') && request.method() === 'POST') {
        datasourceCalls++;
        const body = JSON.parse(request.postData());
        const results = Object.fromEntries((body.queries || []).map(query => [query.refId || 'A', { status: 200, frames: [frame(query.refId || 'A')] }]));
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
      }
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        requests.push(JSON.parse(request.postData()));
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: 120, completion_tokens: 80 } }) });
      }
      return request.continue();
    });
    await page.goto(`${root}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!response.ok) throw new Error(`Login failed: ${response.status}`);
    });
    settings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    stage = 'create temporary dashboard';
    await page.evaluate(async ({ uid, title, from, to }) => {
      const response = await fetch('/crf/dashboard/api/dashboards/db', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: {
          id: null, uid, title: 'Tech AI 0.8.6 browser test', timezone: 'utc', schemaVersion: 42, version: 0,
          panels: [{ id: 1, title, type: 'timeseries', datasource: { type: 'loki', uid: 'loki' },
            targets: [{ refId: 'A', expr: '{service_name="keycloak"}', datasource: { type: 'loki', uid: 'loki' } }],
            fieldConfig: { defaults: { unit: 'reqps' }, overrides: [] },
            options: { legend: { displayMode: 'list', placement: 'bottom' } }, gridPos: { h: 8, w: 24, x: 0, y: 0 } }],
          time: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        }, overwrite: false }),
      });
      if (!response.ok) throw new Error(`Create dashboard failed: ${response.status}`);
    }, { uid, title, from, to });
    created = true;
    const dashboard = `${root}/d/${uid}/pod-metrics?from=${from}&to=${to}`;
    const openAssistant = async () => {
      await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tech-ai-assistant-launcher');
      await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.delete('timezone');
        history.replaceState(history.state, '', url);
      });
      await page.click('#tech-ai-assistant-launcher');
      await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    };
    const explain = async () => {
      await page.waitForSelector('[data-testid="tech-ai-welcome"] button');
      await page.$eval('[data-testid="tech-ai-welcome"] button', node => node.click());
      await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
      await page.select('[data-testid="tech-ai-data-mode"]', 'sample');
      await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
      await page.waitForSelector('[data-testid="tech-ai-answer-charts"]');
      await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    };
    stage = 'eight rows and lazy mounting';
    await openAssistant();
    await explain();
    assert.equal(requests.length, 1);
    const sent = contextOf(requests[0]).panelData.flatMap(panel => panel.results.flatMap(query => query.result.series || []));
    assert.equal(sent.length, 8, 'All eight series must reach the model');
    assert.deepEqual(sent.map(series => series.name).sort(), Array.from({ length: 8 }, (_, index) => `pod=api-${index}`));
    assert.equal(sent.find(series => series.name === 'pod=api-6').max, 95);
    assert.ok(sent.every(series => series.unit == null), 'Fixture frames deliberately have no unit');
    assert.equal(await page.$eval('[data-testid="tech-ai-answer-charts"]', node => node.open), false);
    assert.equal(await page.$('[data-testid="tech-ai-chart-card"]'), null, 'Collapsed cards must not mount');
    assert.equal(await page.$('[data-testid="tech-ai-sparkline"]'), null, 'Collapsed SVG must not mount');
    const callsBeforeCards = datasourceCalls;
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-chart-series-select"]');
    const select = '[data-testid="tech-ai-chart-series-select"]';
    const options = await page.$$eval(`${select} option`, nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
    assert.equal(options.length, 3, 'Only three highest-maximum transmitted series should be displayed');
    assert.match(options[0].text, /pod=api-6/);
    assert.match(options[1].text, /pod=api-7/);
    assert.match(options[2].text, /pod=api-5/);
    assert.match(await page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent), /95(?:[.,]0+)?\s*req\/s/);
    stage = 'dashboard UTC fallback and mobile layout';
    assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'Europe/Moscow');
    const range = await page.$eval('[data-testid="tech-ai-chart-range"]', node => node.textContent);
    assert.match(range, /09:02/);
    assert.match(range, /09:55/);
    assert.match(range, /\butc\b/i);
    assert.ok(!range.includes('12:02'), `Browser timezone leaked into UTC range: ${range}`);
    await page.select(select, options[1].value);
    assert.match(await page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent), /27(?:[.,]0+)?\s*req\/s/);
    assert.equal(datasourceCalls, callsBeforeCards);
    for (const viewport of [{ width: 1280, height: 650 }, { width: 360, height: 740 }]) {
      await page.setViewport(viewport);
      const layout = await page.evaluate(() => {
        const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
        const composer = document.querySelector('#tech-ai-assistant-drawer textarea').getBoundingClientRect();
        const close = document.querySelector('#tech-ai-assistant-drawer button[title^="Закрыть"]').getBoundingClientRect();
        const history = document.querySelector('[data-testid="tech-ai-history"]');
        history.scrollTop = history.scrollHeight;
        return { inside: drawer.left >= 0 && drawer.right <= innerWidth && composer.bottom <= innerHeight && close.top >= 0 && close.right <= innerWidth, scroll: history.scrollTop > 0, height: history.clientHeight };
      });
      assert.ok(layout.inside && layout.scroll && layout.height > 100, JSON.stringify({ viewport, layout }));
      await page.screenshot({ path: `/test-results/assistant-086-${viewport.width === 360 ? 'mobile' : 'desktop'}.png` });
    }
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForFunction(() => !document.querySelector('[data-testid="tech-ai-chart-card"]'));
    stage = 'panel unit override by refId';
    await page.evaluate(async uid => {
      const latest = await (await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`)).json();
      latest.dashboard.panels[0].fieldConfig = { defaults: { unit: 'percent' }, overrides: [{ matcher: { id: 'byFrameRefID', options: 'A' }, properties: [{ id: 'unit', value: 'reqps' }] }] };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: latest.dashboard, overwrite: false }) });
      if (!response.ok) throw new Error(`Set temporary override failed: ${response.status}`);
    }, uid);
    await page.setViewport({ width: 1280, height: 650 });
    await openAssistant();
    await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Новый диалог').click());
    await explain();
    assert.equal(requests.length, 2);
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-chart-card"]');
    assert.match(await page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent), /95(?:[.,]0+)?\s*req\/s/);
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-086-baseline=ok; real Grafana 13/temporary dashboard; mock model/data; eight sent series, three peak-ranked cards, lazy SVG, panel default/refId unit, dashboard UTC fallback against Moscow browser, desktop/mobile');
    stage = 'unit override with datasource unit';
    frameUnit = 'percent';
    valuesScale = 1 / 190;
    await page.evaluate(async uid => {
      const latest = await (await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`)).json();
      latest.dashboard.panels[0].fieldConfig = { defaults: { unit: 'reqps' }, overrides: [{ matcher: { id: 'byFrameRefID', options: 'A' }, properties: [{ id: 'unit', value: 'percentunit' }] }] };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: latest.dashboard, overwrite: false }) });
      if (!response.ok) throw new Error(`Set temporary percent override failed: ${response.status}`);
    }, uid);
    await openAssistant();
    await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Новый диалог').click());
    await explain();
    assert.equal(requests.length, 3);
    const scaled = contextOf(requests[2]).panelData.flatMap(panel => panel.results.flatMap(query => query.result.series || []));
    const api6 = scaled.find(series => series.name === 'pod=api-6');
    assert.equal(api6.unit, 'percent');
    assert.equal(api6.max, 0.5);
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-chart-card"]');
    const overrideCard = await page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent);
    console.log(`release-086-unit-override-card=${overrideCard}`);
    assert.match(overrideCard, /макс\s+50(?:[.,]0+)?\s*%/, 'Panel percentunit override must scale a datasource percent value of 0.5 to 50%');
    stage = 'unit override by raw field name';
    await page.evaluate(async uid => {
      const latest = await (await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`)).json();
      latest.dashboard.panels[0].fieldConfig = { defaults: { unit: 'reqps' }, overrides: [{ matcher: { id: 'byName', options: 'Value' }, properties: [{ id: 'unit', value: 'percentunit' }] }] };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: latest.dashboard, overwrite: false }) });
      if (!response.ok) throw new Error(`Set temporary raw-name override failed: ${response.status}`);
    }, uid);
    await openAssistant();
    await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Новый диалог').click());
    await explain();
    assert.equal(requests.length, 4);
    const named = contextOf(requests[3]).panelData.flatMap(panel => panel.results.flatMap(query => query.result.series || []));
    assert.equal(named.find(series => series.name === 'pod=api-6').max, 0.5);
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-chart-card"]');
    const rawNameCard = await page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent);
    console.log(`release-086-raw-name-override-card=${rawNameCard}`);
    assert.match(rawNameCard, /макс\s+50(?:[.,]0+)?\s*%/, 'byName=Value must match the raw field despite pod labels in the display name');
    stage = 'unit override by native label display name';
    await page.evaluate(async uid => {
      const latest = await (await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`)).json();
      latest.dashboard.panels[0].fieldConfig = { defaults: { unit: 'reqps' }, overrides: [{ matcher: { id: 'byName', options: 'api-6' }, properties: [{ id: 'unit', value: 'percentunit' }] }] };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: latest.dashboard, overwrite: false }) });
      if (!response.ok) throw new Error(`Set temporary label-display override failed: ${response.status}`);
    }, uid);
    await openAssistant();
    await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Новый диалог').click());
    await explain();
    assert.equal(requests.length, 5);
    const labelNamed = contextOf(requests[4]).panelData.flatMap(panel => panel.results.flatMap(query => query.result.series || []));
    assert.equal(labelNamed.find(series => series.name === 'pod=api-6').max, 0.5);
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-chart-card"]');
    const labelNameCard = await page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent);
    console.log(`release-086-label-name-override-card=${labelNameCard}`);
    assert.match(labelNameCard, /макс\s+50(?:[.,]0+)?\s*%/, 'byName=api-6 must match Grafana native display name from the single pod label');
    await page.$eval('[data-testid="tech-ai-history"]', node => { node.scrollTop = node.scrollHeight; });
    await page.screenshot({ path: '/test-results/assistant-086-fixed.png' });
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-086-test=ok; baseline, datasource-unit precedence, raw-field and native-label byName override regressions');
  } catch (error) {
    console.error(`release-086-test stage=${stage}`);
    if (!page.isClosed()) await page.screenshot({ path: '/test-results/assistant-086-failure.png' }).catch(() => {});
    throw error;
  } finally {
    try {
      if (created && !page.isClosed()) await page.evaluate(async uid => {
        const response = await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`Temporary dashboard cleanup failed: ${response.status}`);
      }, uid);
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
