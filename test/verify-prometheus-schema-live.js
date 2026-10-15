const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = 'tech-prometheus-schema-live';
const dsUid = 'tech-prometheus-live';
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const statuses = [], results = [];
  let settings, calls = 0, createdDs = false, createdDashboard = false;
  try {
    page.setDefaultTimeout(30000);
    await page.setRequestInterception(true);
    page.on('response', response => {
      if (response.url().includes(`/api/datasources/proxy/uid/${dsUid}/api/v1/`)) statuses.push({ url: response.url(), status: response.status() });
    });
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const respond = value => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (settings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return respond({ ...settings, jsonData: { provider: 'custom', model: 'Live Prometheus schema test', toolsMode: 'text', streaming: false, includePanelData: false, schemaDiscoveryEnabled: true, previewBeforeSend: 'always', launcherMode: 'both' } });
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        const body = JSON.parse(request.postData());
        const last = body.messages.at(-1);
        if (typeof last.content === 'string' && last.content.startsWith('Результаты запросов')) results.push(JSON.parse(last.content.split('\n')[1]));
        calls++;
        const batches = [
          [{ action: 'metrics', match: 'tech_exporter_memory' }, { action: 'labels' }, { action: 'label_values', label: 'kind' }],
          [{ action: 'metrics', match: 'tech_exporter_probe_' }, { action: 'metrics', match: 'absent_metric_xyz' }, { action: 'metrics', match: 'tech_exporter_memory.' }],
        ];
        const content = calls <= 2 ? batches[calls - 1].map(args => '```grafana-schema\n' + JSON.stringify({ datasourceUid: dsUid, reason: 'Live exporter verification', ...args }) + '\n```').join('\n') : 'PROMETHEUS LIVE VERIFIED';
        return respond({ choices: [{ message: { content } }] });
      }
      return request.continue();
    });
    await page.goto(`${root}/login`);
    await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!response.ok) throw new Error('Login failed');
    });
    settings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    await page.evaluate(async dsUid => {
      const response = await fetch('/crf/dashboard/api/datasources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: dsUid, name: dsUid, type: 'prometheus', access: 'proxy', url: 'http://tech-ai-prometheus-live:9090', jsonData: { httpMethod: 'POST', timeInterval: '1s' } }) });
      if (!response.ok) throw new Error('Create datasource: ' + await response.text());
    }, dsUid); createdDs = true;
    await page.waitForFunction(async dsUid => {
      const result = await (await fetch(`/crf/dashboard/api/datasources/proxy/uid/${dsUid}/api/v1/query?query=tech_exporter_memory_bytes`)).json();
      return result.status === 'success' && result.data.result.length === 2;
    }, {}, dsUid);
    statuses.length = 0;
    await page.evaluate(async ({ uid, dsUid }) => {
      const dashboard = { uid, title: 'Live Prometheus schema test', schemaVersion: 42, panels: [{ id: 1, title: 'Exporter memory', type: 'timeseries', datasource: { uid: dsUid, type: 'prometheus' }, targets: [{ refId: 'A', expr: 'tech_exporter_memory_bytes', datasource: { uid: dsUid, type: 'prometheus' } }], gridPos: { x: 0, y: 0, w: 24, h: 8 } }], time: { from: 'now-5m', to: 'now' } };
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard, overwrite: false }) });
      if (!response.ok) throw new Error('Create dashboard failed');
    }, { uid, dsUid }); createdDashboard = true;
    await page.goto(`${root}/a/tech-ai-assistant-app?dashboardUid=${uid}&from=now-5m&to=now`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
    assert.equal(statuses.length, 0, 'Opening assistant must not trigger metadata discovery');
    await page.select('[data-testid="tech-ai-composer-data-mode"]', 'investigation');
    await page.type('[data-testid="tech-ai-composer"] textarea', 'Проверь метрики и labels экспортера');
    const click = label => page.evaluate(label => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label).click(), label);
    await click('Отправить');
    await page.waitForSelector('[data-testid="tech-ai-investigation-setup"]');
    await page.click('[data-testid="tech-ai-allow-queries"]');
    await page.click('[data-testid="tech-ai-allow-schema"]');
    await click('Начать расследование');
    await page.waitForFunction(() => document.body.textContent.includes('PROMETHEUS LIVE VERIFIED'));
    assert.equal(calls, 3);
    assert.equal(statuses.length, 6);
    assert.ok(statuses.every(item => item.status === 200), JSON.stringify(statuses));
    assert.equal(results.length, 2);
    const outputs = results.flat();
    assert.equal(outputs.length, 6);
    assert.ok(outputs.every(value => value.kind === 'schema' && !value.error), JSON.stringify(outputs));
    assert.deepEqual(outputs[0].items, ['tech_exporter_memory_bytes']);
    for (const label of ['environment', 'kind', 'job', 'instance', '__name__']) assert.ok(outputs[1].items.includes(label), label);
    assert.deepEqual(outputs[2].items, ['free', 'total']);
    assert.equal(outputs[3].total, 105); assert.equal(outputs[3].truncated, true); assert.equal(outputs[3].items.length, 100);
    assert.deepEqual(outputs[4].items, []); assert.equal(outputs[4].total, 0);
    assert.deepEqual(outputs[5].items, []); assert.equal(outputs[5].total, 0);
    assert.ok(outputs.every(value => Number.isFinite(Date.parse(value.range.from)) && Number.isFinite(Date.parse(value.range.to))));
    const escaped = new URL(statuses.at(-1).url).searchParams.get('match[]');
    assert.ok(escaped.includes('\\\\.'), escaped);
    await page.screenshot({ path: '/test-results/assistant-prometheus-schema-live.png', fullPage: true });
    console.log('live-prometheus-schema=ok; 6 real HTTP 200 requests; metric search, labels, label_values, 105-name truncation, empty search, regex literal escaping; actual exporter samples; only LLM mocked');
  } finally {
    try {
      await page.evaluate(async ({ uid, dsUid, createdDashboard, createdDs }) => {
        for (const path of [createdDashboard && `/api/dashboards/uid/${uid}`, createdDs && `/api/datasources/uid/${dsUid}`].filter(Boolean)) {
          const response = await fetch('/crf/dashboard' + path, { method: 'DELETE' });
          if (!response.ok) throw new Error('Cleanup failed: ' + path);
        }
      }, { uid, dsUid, createdDashboard, createdDs });
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
