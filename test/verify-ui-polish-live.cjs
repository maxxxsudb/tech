const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const root = process.env.GRAFANA_TEST_URL || 'http://localhost:3300/crf/dashboard';
const uid = 'ai-ui-' + Date.now().toString(36), phase = process.env.UI_POLISH_EXPECT === '1' ? 'after' : 'before';
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const report = { phase, observations: [], errors: [] };
const protectedUi = process.env.UI_POLISH_PROTECTED === '1';
const output = phase + (protectedUi ? '-protected' : '');
const moduleBytes = protectedUi ? fs.readFileSync('protected/tech-ai-assistant-app/module.js') : process.env.UI_POLISH_BASELINE === '1' ? require('node:child_process').execFileSync('git', ['show', 'v0.9.13:plugin/module.js']) : undefined;
let browser, created = false;
async function api(path, method = 'GET', body) {
  const response = await fetch(root + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, path + ': ' + response.status); return response.json();
}
(async () => {
  try {
    const datasource = { uid: uid + '-pg', type: 'grafana-postgresql-datasource' };
    await api('/api/dashboards/db', 'POST', { dashboard: { uid, title: 'SQL interface review', schemaVersion: 42, time: { from: 'now-1h', to: 'now' }, panels: [{ id: 1, type: 'text', title: 'Orders SQL', datasource, targets: [{ refId: 'A', datasource, rawSql: 'SELECT 1', format: 'table' }], options: { mode: 'markdown', content: 'Isolated UI fixture' }, gridPos: { x: 0, y: 0, w: 24, h: 8 } }] }, overwrite: false }); created = true;
    const settings = await api('/api/plugins/tech-ai-assistant-app/settings');
    browser = await puppeteer.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(); page.setDefaultTimeout(60000); await page.setCacheEnabled(false);
    await page.goto(root + '/login');
    await page.evaluate(async () => { const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!response.ok) throw Error('Login'); });
    let writes = 0, models = 0, queries = 0;
    page.on('pageerror', error => report.errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname, respond = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (moduleBytes && path.endsWith('/public/plugins/tech-ai-assistant-app/module.js')) return request.respond({ status: 200, contentType: 'application/javascript', body: moduleBytes });
      if (path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return respond({ ...settings, jsonData: { ...settings.jsonData, provider: 'custom', model: 'UI fixture', includePanelData: false, streaming: false, alertingEnabled: true } });
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) { models++; return respond({ choices: [{ message: { content: 'No model call expected' } }] }); }
      if (path.endsWith('/api/ds/query')) { queries++; return respond({ results: {} }); }
      if (request.method() !== 'GET' && /\/api\/(?:dashboards|v1\/provisioning|alertmanager)/.test(path)) writes++;
      if (path.endsWith('/api/v1/provisioning/alert-rules/' + uid)) return respond({ uid, title: 'Orders SQL alert', isPaused: true, for: '5m', data: [{ refId: 'A', datasourceUid: datasource.uid, model: { refId: 'A', datasource, rawSql: 'SELECT 1', format: 'time_series' } }] });
      if (path.endsWith('/api/prometheus/grafana/api/v1/rules')) return respond({ status: 'success', data: { groups: [] } });
      if (path.endsWith('/api/alertmanager/grafana/api/v2/alerts')) return respond([]);
      return request.continue();
    });
    const open = async () => { await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher'); await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])'); };
    const measure = () => page.evaluate(() => {
      const composer = document.querySelector('[data-testid="tech-ai-composer"]'), input = composer.querySelector('textarea'), bounds = composer.getBoundingClientRect();
      return { placeholder: input.placeholder, composerVisible: bounds.top >= 0 && bounds.bottom <= innerHeight, horizontalOverflow: composer.scrollWidth > composer.clientWidth + 1, inputHeight: input.getBoundingClientRect().height };
    });
    for (const theme of ['dark', 'light']) for (const width of [1400, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(root + '/d/' + uid + '?theme=' + theme, { waitUntil: 'domcontentloaded' }); await open();
      const state = await measure(); report.observations.push({ scene: 'sql', theme, width, ...state });
      assert.ok(state.composerVisible); assert.equal(state.horizontalOverflow, false);
      if (phase === 'after') assert.match(state.placeholder, /SQL/);
      await page.$eval('#tech-ai-assistant-drawer', node => { node.querySelector('textarea')?.blur(); });
      await (await page.$('#tech-ai-assistant-drawer')).screenshot({ path: 'test-results/ui-polish-' + output + '-sql-' + theme + '-' + width + '.png' });
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(root + '/alerting/grafana/' + uid + '/view', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.setItem('tech-ai-assistant:silence-pending:v1:1', JSON.stringify({ at: Date.now(), id: 'pending-ui-fixture', body: {} })));
    await open(); await page.waitForSelector('[data-testid="tech-ai-silence-pending"]');
    const pending = await page.$eval('[data-testid="tech-ai-silence-reconcile"]', node => {
      const r = node.getBoundingClientRect(); let collapsed = false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) collapsed = true;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { visible: !collapsed && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && (hit === node || node.contains(hit)) };
    });
    report.observations.push({ scene: 'pending-silence', width: 390, ...pending, ...await measure() });
    if (phase === 'after') { assert.ok(pending.visible); assert.match((await measure()).placeholder, /алерт/); assert.equal(await page.$('[data-testid="tech-ai-silence-startsAt"]'), null); }
    else assert.equal(pending.visible, false);
    await (await page.$('#tech-ai-assistant-drawer')).screenshot({ path: 'test-results/ui-polish-' + output + '-pending-mobile.png' });
    assert.equal(writes, 0); assert.equal(models, 0); assert.equal(queries, 0); assert.deepEqual(report.errors, []);
    report.ok = true; report.writes = writes;
  } catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    if (created) await api('/api/dashboards/uid/' + uid, 'DELETE');
    if (moduleBytes) report.moduleSHA256 = require('node:crypto').createHash('sha256').update(moduleBytes).digest('hex');
    fs.writeFileSync('test-results/ui-polish-' + output + '.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  }
})();
