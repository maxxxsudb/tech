const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');

const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-charts-${Date.now().toString(36)}`;
const title = 'CPU and memory';
const from = Date.UTC(2026, 9, 7, 9);
const to = from + 3600000;
const times = [2, 12, 22, 32, 42, 55].map(minute => from + minute * 60000);
const cpu = [12, 78, null, 20, 18, 24];
const memory = [1, 2, 4, null, 2, 3].map(value => value === null ? null : value * 1024 ** 3);
const answer = `## Нагрузка\n\nПанель ${title} показывает CPU и память с разными единицами измерения. Пропуски не означают нулевую нагрузку.\n\n` + 'Пояснение для проверки прокрутки: сравните пик с соседними точками и журналом событий.\n\n'.repeat(18);

function frame(refId) {
  return {
    schema: { refId, name: 'Resource usage', fields: [
      { name: 'Time', type: 'time' },
      { name: 'CPU', type: 'number', config: { displayNameFromDS: 'CPU', unit: 'percent' } },
      { name: 'Memory', type: 'number', config: { displayNameFromDS: 'Memory', unit: 'bytes' } },
    ] },
    data: { values: [times, cpu, memory] },
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
  let originalSettings, preferences, created = false, chartsEnabled = true, seriesLimit = 2, datasourceCalls = 0;
  let stage = 'login';
  try {
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 650 });
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (originalSettings && pathname.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method() === 'GET') {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...originalSettings, enabled: true, jsonData: {
          provider: 'custom', model: 'UI 085 mock', apiUrl: 'http://unused', apiPath: '/v1/chat/completions',
          launcherMode: 'both', includePanelData: true, streaming: false, previewBeforeSend: 'always',
          answerCharts: chartsEnabled, maxSeriesPerQuery: seriesLimit, explainSampleRows: 3, contextTokens: 8192,
        } }) });
      }
      if (pathname.endsWith('/api/ds/query') && request.method() === 'POST') {
        datasourceCalls++;
        const body = JSON.parse(request.postData());
        const results = Object.fromEntries((body.queries || []).map(query => [query.refId || 'A', { status: 200, frames: [frame(query.refId || 'A')] }]));
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
      }
      if (pathname.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
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
    originalSettings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    preferences = await page.evaluate(async () => (await fetch('/crf/dashboard/api/user/preferences')).json());
    stage = 'create temporary dashboard';
    await page.evaluate(async ({ uid, title, from, to }) => {
      const response = await fetch('/crf/dashboard/api/dashboards/db', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: {
          id: null, uid, title: 'Tech AI mini-chart browser test', schemaVersion: 42, version: 0,
          panels: [{ id: 1, title, type: 'timeseries', datasource: { type: 'loki', uid: 'loki' },
            targets: [{ refId: 'A', expr: '{service_name="keycloak"}', datasource: { type: 'loki', uid: 'loki' } }],
            fieldConfig: { defaults: {}, overrides: [] }, options: { legend: { displayMode: 'list', placement: 'bottom' } }, gridPos: { h: 8, w: 24, x: 0, y: 0 } }],
          time: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        }, overwrite: false }),
      });
      if (!response.ok) throw new Error(`Create dashboard failed: ${response.status}`);
    }, { uid, title, from, to });
    created = true;
    const dashboard = `${root}/d/${uid}/mini-chart-test?from=${from}&to=${to}&timezone=UTC`;
    const openAssistant = async () => {
      await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tech-ai-assistant-launcher');
      await page.click('#tech-ai-assistant-launcher');
      await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    };
    stage = 'collect sample and render answer';
    await openAssistant();
    await page.$eval('[data-testid="tech-ai-welcome"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
    await page.select('[data-testid="tech-ai-data-mode"]', 'sample');
    await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-answer-charts"]');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    assert.equal(requests.length, 1);
    const context = contextOf(requests[0]);
    const sentSeries = context.panelData.flatMap(panel => panel.results.flatMap(query => query.result.series || []));
    assert.deepEqual(sentSeries.map(series => series.name).sort(), ['CPU', 'Memory']);
    assert.equal(context.charts, undefined, 'Local mini-chart points must not become model context');
    assert.ok(!JSON.stringify(context).includes('"points":['), 'Full sparkline points must stay local');
    assert.equal(await page.$eval('[data-testid="tech-ai-answer-charts"]', node => node.tagName), 'DETAILS');
    assert.equal(await page.$eval('[data-testid="tech-ai-answer-charts"]', node => node.open), false);
    const summary = await page.$eval('[data-testid="tech-ai-answer-charts"] summary', node => node.textContent);
    assert.match(summary, /Данные к ответу/i);
    assert.match(summary, /1/);
    const callsBeforeCards = datasourceCalls;
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-sparkline"]', { visible: true });
    assert.equal(await page.$$eval('[data-testid="tech-ai-chart-card"]', nodes => nodes.length), 1);
    const select = '[data-testid="tech-ai-chart-series-select"]';
    const options = await page.$$eval(`${select} option`, nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
    assert.equal(options.length, 2);
    const choose = async name => {
      const option = options.find(option => option.text.includes(name));
      assert.ok(option, `Missing series selector option: ${name}`);
      await page.waitForSelector(select, { visible: true });
      await page.select(select, option.value);
      return page.$eval('[data-testid="tech-ai-chart-card"]', node => node.textContent);
    };
    stage = 'switch series and inspect real range';
    const cpuCard = await choose('CPU');
    assert.ok(cpuCard.includes('78%'), cpuCard);
    assert.ok(cpuCard.includes('24%'), cpuCard);
    const memoryCard = await choose('Memory');
    assert.match(memoryCard, /4\s*(?:GiB|GB)/);
    assert.match(memoryCard, /3\s*(?:GiB|GB)/);
    const range = await page.$eval('[data-testid="tech-ai-chart-range"]', node => node.textContent);
    const expectedTimes = await page.evaluate(times => times.map(value => new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: new URL(location.href).searchParams.get('timezone'),
    }).format(new Date(value))), [times[0], times.at(-1)]);
    for (const time of expectedTimes) assert.ok(range.includes(time), `Actual data range missing ${time}: ${range}`);
    assert.ok(range.includes('UTC'), range);
    const path = await page.$eval('[data-testid="tech-ai-sparkline"] path[stroke]:not([stroke="none"])', node => node.getAttribute('d'));
    assert.ok((path.match(/M/g) || []).length >= 2, `Missing gap in sparkline path: ${path}`);
    assert.equal(datasourceCalls, callsBeforeCards, 'Expanding charts and switching a series must not query datasource');
    stage = 'dashboard focus and responsive layout';
    await page.click('[data-testid="tech-ai-expand"]');
    assert.equal(await page.$eval('#tech-ai-assistant-drawer', node => node.style.width), '100vw');
    const before = page.url();
    await page.click('[data-testid="tech-ai-chart-open"]');
    await page.waitForSelector('.tech-ai-panel-highlight');
    assert.equal(page.url(), before);
    assert.notEqual(await page.$eval('#tech-ai-assistant-drawer', node => node.style.width), '100vw');
    assert.ok(await page.$eval('.tech-ai-panel-highlight', (node, title) => node.textContent.includes(title), title));
    for (const viewport of [{ width: 1280, height: 650 }, { width: 360, height: 740 }]) {
      await page.setViewport(viewport);
      const layout = await page.evaluate(() => {
        const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
        const composer = document.querySelector('#tech-ai-assistant-drawer textarea').getBoundingClientRect();
        const close = document.querySelector('#tech-ai-assistant-drawer button[title^="Закрыть"]').getBoundingClientRect();
        const history = document.querySelector('[data-testid="tech-ai-history"]');
        history.scrollTop = 0;
        history.scrollTop = history.scrollHeight;
        const card = document.querySelector('[data-testid="tech-ai-chart-card"]').getBoundingClientRect();
        return { inside: drawer.left >= 0 && drawer.right <= innerWidth && composer.bottom <= innerHeight && close.top >= 0 && close.right <= innerWidth,
          scroll: history.scrollTop > 0, cardInside: card.left >= drawer.left && card.right <= drawer.right, height: history.clientHeight };
      });
      assert.ok(layout.inside && layout.scroll && layout.cardInside && layout.height > 100, JSON.stringify({ viewport, layout }));
      await page.screenshot({ path: `/test-results/assistant-085-${viewport.width === 360 ? 'mobile' : 'desktop'}.png` });
    }
    stage = 'light theme';
    await page.setViewport({ width: 1280, height: 650 });
    await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
      if (!response.ok) throw new Error(`Light theme failed: ${response.status}`);
    });
    await openAssistant();
    await page.waitForSelector('[data-testid="tech-ai-answer-charts"]');
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await choose('Memory');
    const background = await page.$eval('#tech-ai-assistant-drawer', node => getComputedStyle(node).backgroundColor);
    assert.ok(background.match(/\d+/g).slice(0, 3).every(value => Number(value) > 150), `Light theme background: ${background}`);
    await page.$eval('[data-testid="tech-ai-history"]', node => { node.scrollTop = node.scrollHeight; });
    await page.screenshot({ path: '/test-results/assistant-085-light.png' });
    stage = 'disabled configuration';
    chartsEnabled = false;
    await page.setViewport({ width: 1280, height: 650 });
    await openAssistant();
    await page.waitForSelector('[data-testid="tech-ai-answer"]');
    assert.equal(await page.$('[data-testid="tech-ai-answer-charts"]'), null, 'answerCharts=false must hide saved mini-chart cards');
    assert.equal(requests.length, 1, 'Hiding saved charts must not regenerate model response');
    stage = 'match charts to limited model context';
    chartsEnabled = true;
    seriesLimit = 1;
    await openAssistant();
    await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Новый диалог').click());
    await page.waitForSelector('[data-testid="tech-ai-welcome"] button');
    await page.$eval('[data-testid="tech-ai-welcome"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
    await page.select('[data-testid="tech-ai-data-mode"]', 'sample');
    await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-answer-charts"]');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    assert.equal(requests.length, 2);
    const limited = contextOf(requests[1]).panelData.flatMap(panel => panel.results.flatMap(query => query.result.series || []));
    assert.equal(limited.length, 1);
    await page.click('[data-testid="tech-ai-answer-charts"] summary');
    await page.waitForSelector('[data-testid="tech-ai-chart-card"]', { visible: true });
    assert.equal(await page.$('[data-testid="tech-ai-chart-series-select"]'), null, 'Unsent series must not appear in the answer card');
    assert.equal(await page.$eval('[data-testid="tech-ai-chart-card"] .tech-ai-chart-series', node => node.textContent), limited[0].name);
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-085-test=ok; real Grafana 13 and temporary dashboard; mock model/data fixture; collapsed charts, series units/stats, actual UTC range, gaps, no extra datasource queries, focus, desktop/mobile/light theme, answerCharts=false, exact limited model context');
  } catch (error) {
    console.error(`release-085-test stage=${stage}`);
    if (!page.isClosed()) await page.screenshot({ path: '/test-results/assistant-085-failure.png' }).catch(() => {});
    throw error;
  } finally {
    try {
      if (preferences && !page.isClosed()) await page.evaluate(preferences => fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) }), preferences);
      if (created && !page.isClosed()) {
        await page.evaluate(async uid => {
          const response = await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' });
          if (!response.ok) throw new Error(`Temporary dashboard cleanup failed: ${response.status}`);
        }, uid);
      }
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
