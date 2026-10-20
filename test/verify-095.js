const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const suffix = Date.now().toString(36), ruleUid = 'ai095-' + suffix;
const dashboards = ['a', 'b'].map(name => 'ai095-' + name + '-' + suffix);
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [], modelRequests = [], dataRequests = [];
  let originalSettings, folderUid, ruleCreated = false, denied = false, stage = 'login';
  const createdDashboards = [];
  page.setDefaultTimeout(30000);
  const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const r = await fetch('/crf/dashboard' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  }, { path, method, body });
  const click = label => page.evaluate(label => {
    const node = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === label);
    if (!node) throw Error('Missing ' + label); node.click();
  }, label);
  const navigate = path => page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, '/crf/dashboard' + path);
  try {
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setCacheEnabled(false);
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const respond = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (originalSettings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return respond({ ...originalSettings, jsonData: { ...originalSettings.jsonData, model: 'UI mock', provider: 'custom', streaming: false, previewBeforeSend: 'never', includePanelData: true, alertingEnabled: true, contextTokens: 32768, launcherMode: 'both' } });
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) { modelRequests.push(JSON.parse(request.postData())); return respond({ choices: [{ message: { content: 'Rule explanation based on the supplied context.' } }] }); }
      if (path.endsWith('/api/ds/query') && request.method() === 'POST') { dataRequests.push(JSON.parse(request.postData())); return respond({ results: {} }); }
      if (denied && path.endsWith('/api/alertmanager/grafana/api/v2/alerts')) return respond({ message: 'Forbidden fixture' }, 403);
      return request.continue();
    });
    await page.goto(root + '/login', { waitUntil: 'domcontentloaded' });
    await api('/login', 'POST', { user: 'admin', password: 'admin' });
    originalSettings = await api('/api/plugins/tech-ai-assistant-app/settings');
    const health = await api('/api/health'); assert.equal(health.version, '13.2.2');
    stage = 'fixtures';
    const folder = await api('/api/folders', 'POST', { title: 'Tech AI 095 test ' + suffix }); folderUid = folder.uid;
    for (const [index, uid] of dashboards.entries()) {
      await api('/api/dashboards/db', 'POST', { dashboard: { uid, title: 'AI 095 dashboard ' + index, schemaVersion: 41, panels: [{ id: index + 1, title: 'Distinct panel ' + index, type: 'text', gridPos: { x: 0, y: 0, w: 12, h: 8 }, options: { mode: 'markdown', content: 'Test fixture' }, targets: [] }] }, folderUid });
      createdDashboards.push(uid);
    }
    await api('/api/v1/provisioning/alert-rules', 'POST', { uid: ruleUid, orgID: 1, folderUID: folderUid, ruleGroup: 'AI 095 fixtures', title: 'AI 095 paused rule', condition: 'A', data: [{ refId: 'A', datasourceUid: '__expr__', relativeTimeRange: { from: 0, to: 0 }, model: { refId: 'A', type: 'math', expression: '1 == 1', datasource: { uid: '__expr__', type: '__expr__' }, intervalMs: 1000, maxDataPoints: 43200 } }], noDataState: 'NoData', execErrState: 'Error', for: '0s', isPaused: true, labels: { service: 'billing', severity: 'warning' }, annotations: { summary: 'Paused E2E fixture' } });
    ruleCreated = true;
    assert.equal((await api('/api/v1/provisioning/alert-rules/' + ruleUid)).isPaused, true);
    stage = 'dashboard navigation';
    await page.goto(root + '/d/' + dashboards[0], { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer')?.textContent.includes('AI 095 dashboard 0'));
    await navigate('/d/' + dashboards[1]);
    await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer')?.textContent.includes('AI 095 dashboard 1'));
    await page.type('#tech-ai-assistant-drawer [data-testid="tech-ai-composer"] textarea', 'Which dashboard is selected?'); await click('Отправить');
    await page.waitForFunction(() => document.querySelector('.tech-ai-root[data-busy="false"]') && document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('Rule explanation'));
    const dashboardContext = JSON.parse(modelRequests.at(-1).messages[0].content.split('Текущий контекст Grafana:\n')[1]);
    assert.equal(dashboardContext.dashboardUid, dashboards[1]); assert.equal(dashboardContext.panels[0].id, 2);
    stage = 'alert triage';
    await navigate('/alerting/grafana/' + ruleUid + '/view');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-alert-context"]')?.textContent.includes('AI 095 paused rule'));
    const beforeData = dataRequests.length;
    await click('Разобрать алерт');
    await page.waitForFunction(() => document.querySelector('.tech-ai-root[data-busy="false"]') && document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('Rule explanation'));
    const alertContext = JSON.parse(modelRequests.at(-1).messages[0].content.split('Текущий контекст Grafana:\n')[1]);
    assert.equal(alertContext.alerting.rule.uid, ruleUid); assert.equal(alertContext.alerting.rule.isPaused, true);
    assert.equal(dataRequests.length, beforeData);
    assert.ok(!JSON.stringify(modelRequests.at(-1)).includes(dashboards[1]));
    await page.screenshot({ path: '/test-results/assistant-095-alerting.png' });
    stage = '403'; denied = true;
    await click('Обновить');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-alert-context"]')?.textContent.includes('Число экземпляров не получено'));
    assert.ok((await page.$eval('[data-testid="tech-ai-alert-context"]', node => node.textContent)).includes('Нет права чтения'));
    assert.equal(dataRequests.length, beforeData); assert.deepEqual(errors, []);
    console.log('release-095-test=ok; real Grafana 13.2.2, SPA context switch, paused rule read/triage, no hidden datasource requests, 403; model mocked');
  } catch (error) {
    await page.screenshot({ path: '/test-results/assistant-095-error.png' }).catch(() => {});
    throw Error(stage + ': ' + error.message);
  } finally {
    denied = false;
    try {
      if (ruleCreated) await api('/api/v1/provisioning/alert-rules/' + ruleUid, 'DELETE');
      for (const uid of createdDashboards) await api('/api/dashboards/uid/' + uid, 'DELETE');
      if (folderUid) await api('/api/folders/' + folderUid, 'DELETE');
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
