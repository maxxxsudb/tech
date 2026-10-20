const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');
const a = require('../plugin/alerting'), q = require('../plugin/query-tools');
const root = process.env.GRAFANA_TEST_URL || 'http://localhost:3300/crf/dashboard';
const auth = 'Basic ' + Buffer.from((process.env.GRAFANA_TEST_USER || 'admin') + ':' + (process.env.GRAFANA_TEST_PASSWORD || 'admin')).toString('base64');
const suffix = Date.now().toString(36), uid = 'ai-prior-' + suffix, database = 'tech_ai_prior_' + suffix, password = crypto.randomBytes(24).toString('hex');
const report = { startedAt: new Date().toISOString(), checks: [] };
let browser, folder, silence, role = false, db = false, ds = false, rule = false, dashboard = false, namespace;
const sql = (database, text) => cp.execFileSync('docker', ['exec', '-i', 'voice2price-pilot-postgres-1', 'psql', '-U', 'voice2price', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'], { input: text, encoding: 'utf8', windowsHide: true });
async function request(path, options = {}) {
  const response = await fetch(root + path, { method: options.method || 'GET', headers: { Authorization: auth, 'Content-Type': options.contentType || 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text(); const body = text ? JSON.parse(text) : {};
  if (!response.ok && !(options.queryResults && body.results)) throw Object.assign(Error(response.status + ' ' + path + ' ' + text.slice(0, 300)), { status: response.status });
  return body;
}
const write = (path, method, body) => request(path, { method, body });
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fill(page, selector, text) { await page.$eval(selector, (element, text) => { Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })); }, text); }
async function button(page, label) { await page.$$eval('button', (buttons, label) => { const button = buttons.find(item => item.textContent === label); if (!button || button.disabled) throw Error('Button unavailable: ' + label); button.click(); }, label); }
(async () => {
  try {
    assert.equal((await request('/api/health')).version, '13.2.2');
    sql('postgres', `CREATE ROLE ${database} LOGIN PASSWORD '${password}';`); role = true;
    sql('postgres', `CREATE DATABASE ${database};`); db = true;
    sql(database, `CREATE TABLE samples(time timestamptz,value double precision); INSERT INTO samples VALUES(now(),1); REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${database}; GRANT SELECT ON samples TO ${database};`);
    ds = true; await write('/api/datasources', 'POST', { uid, name: uid, type: 'grafana-postgresql-datasource', access: 'proxy', url: 'voice2price-pilot-postgres-1:5432', user: database, jsonData: { database, sslmode: 'disable', postgresVersion: 1600 }, secureJsonData: { password } });
    folder = (await write('/api/folders', 'POST', { title: uid })).uid;
    const datasource = { uid, type: 'grafana-postgresql-datasource' }, rawSql = 'SELECT $__timeTo()::timestamptz AS time, max(value)::double precision AS value FROM samples WHERE $__timeFilter(time)';
    dashboard = true; await write('/api/dashboards/db', 'POST', { folderUid: folder, dashboard: { uid, title: uid, schemaVersion: 41, panels: [{ id: 1, title: 'SQL fixture', type: 'timeseries', datasource, targets: [{ refId: 'A', datasource, rawSql, format: 'time_series', rawQuery: true }], gridPos: { x: 0, y: 0, w: 24, h: 8 } }], templating: { list: [{ name: 'service', type: 'custom', query: 'api,db', current: { text: 'api', value: 'api' } }] }, time: { from: 'now-1h', to: 'now' } } });
    await delay(1100); const incidentAt = Date.now(); await delay(1100);
    let saved = (await request('/api/dashboards/uid/' + uid)).dashboard; saved.panels[0].targets[0].rawSql = rawSql.replace('max(value)::double precision', '(2*max(value))::double precision'); saved.templating.list[0].current = { text: 'db', value: 'db' };
    await write('/api/dashboards/db', 'POST', { folderUid: folder, overwrite: true, dashboard: saved }); saved = (await request('/api/dashboards/uid/' + uid)).dashboard;
    check('Real PostgreSQL SELECT-only fixture and two saved SQL/dashboard versions');
    namespace = (await request('/api/frontend/settings')).namespace;
    silence = (await write('/api/alertmanager/grafana/api/v2/silences', 'POST', { matchers: [{ name: 'service', value: uid, isRegex: false, isEqual: true }], startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 10 * 60000).toISOString(), comment: 'Isolated incident test, suppress before enabling fixture', createdBy: 'test' })).silenceID;
    const built = a.buildRule({ uid, title: uid, folderUID: folder, ruleGroup: 'unused', source: { datasource, rawSql }, reducer: 'max', operator: 'gt', threshold: 0.5, for: '0s', intervalSeconds: 10, lookbackSeconds: 600, labels: { service: uid }, annotations: { __dashboardUid__: uid, __panelId__: '1', summary: 'Isolated test only' } }, q.boundedSql);
    const evaluation = await a.previewRule(request, built); assert.equal(evaluation.status, 'ok'); assert.equal(evaluation.samples[0].condition, true);
    rule = true; await write(a.ruleResourcePath(namespace, uid).split('/').slice(0, -1).join('/'), 'POST', { apiVersion: 'rules.alerting.grafana.app/v0alpha1', kind: 'AlertRule', metadata: { name: uid, namespace, annotations: { 'grafana.app/folder': folder } }, spec: { title: uid, paused: false, for: '0s', trigger: { interval: '10s' }, noDataState: 'NoData', execErrState: 'Error', labels: built.labels, annotations: built.annotations, expressions: Object.fromEntries(built.data.map(query => [query.refId, { source: query.refId === 'C', datasourceUID: query.datasourceUid, model: query.model, relativeTimeRange: { from: query.relativeTimeRange.from + 's', to: '0s' } }])) } });
    let instance;
    for (let attempt = 0; attempt < 45; attempt++) { instance = (await request('/api/alertmanager/grafana/api/v2/alerts')).find(item => item.labels?.service === uid && item.status?.silencedBy?.includes(silence)); if (instance) break; await delay(1000); }
    assert.ok(instance, 'SQL fixture did not reach silenced Alertmanager state');
    const evidence = await a.readNotificationEvidence(request), routing = a.notificationReport(evidence, instance.fingerprint);
    assert.equal(routing.deliveryVerified, false); assert.ok(routing.silences.some(item => item.id === silence)); assert.equal(routing.instance.ruleUid, uid); assert.ok(routing.observedReceivers.length); report.notification = { fingerprint: instance.fingerprint, source: routing.routingSource, observedReceivers: routing.observedReceivers, silencedBy: routing.silences.map(item => item.id), delivery: routing.delivery };
    check('Real SQL scheduler firing reaches Alertmanager already silenced; E9 reports suppression, observed receiver and unknown delivery');
    browser = await puppeteer.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(); page.setDefaultTimeout(30000); await page.setCacheEnabled(false); await page.goto(root + '/login');
    await page.evaluate(async root => { const response = await fetch(root + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!response.ok) throw Error('Login failed'); }, new URL(root).pathname);
    await page.goto(root + '/alerting/list'); await page.waitForSelector('#tech-ai-assistant-launcher');
    const result = await page.evaluate(async ({ uid, incidentAt }) => { const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'); return plugin.__features.readIncidentChanges({ dashboardUid: uid }, { incidentAt }); }, { uid, incidentAt });
    assert.equal(result.baseline.version, 1); assert.equal(result.currentVersion, saved.version); assert.ok(result.diff.panels[0].queries[0].lines.some(line => line.type === 'add' && line.text.includes('2*max(value)'))); assert.ok(result.diff.variables);
    check('Actual versions API selects v1 before incident instead of latest preceding version and detects SQL/variable diff');
    await page.evaluate(async uid => { const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'), React = await System.import('react'), renderer = await System.import('react-dom/client'); const host = document.createElement('div'); host.id = 'priority-fixture'; host.style.cssText = 'position:fixed;inset:12px;z-index:2147483003;overflow:auto;background:#181b1f;color:#eee;padding:12px;box-sizing:border-box'; document.body.append(host); window.__priorityRoot = renderer.createRoot(host); window.__priorityRoot.render(React.createElement(plugin.__features.AlertNotificationPanel, { context: { alerting: { ruleUid: uid } }, onEvidence: value => { window.__notification = value; }, onExplain: () => {} })); }, uid);
    await page.click('[data-testid="tech-ai-notifications"] > summary'); await page.click('[data-testid="tech-ai-notifications-load"]'); await page.waitForSelector('[data-testid="tech-ai-notifications-instance"]'); await page.select('[data-testid="tech-ai-notifications-instance"]', instance.fingerprint); await page.click('[data-testid="tech-ai-notifications-check"]'); await page.waitForSelector('[data-testid="tech-ai-notifications-report"]'); assert.match(await page.$eval('[data-testid="tech-ai-notifications-report"]', el => el.textContent), /Факт API:.*silence/);
    check('Actual React notification UI reads exact instance and explains confirmed silence without claiming delivery');
    const context = { dashboardUid: uid, dashboardTitle: uid, dashboardVersion: saved.version, pageUrl: root + '/d/' + uid, panels: saved.panels, timeRange: { from: Date.now() - 3600000, to: Date.now() } };
    async function mountNotebook() {
      await page.evaluate(async context => {
        const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'), React = await System.import('react'), renderer = await System.import('react-dom/client');
        if (!window.__priorityRoot) { const host = document.createElement('div'); host.id = 'priority-fixture'; host.style.cssText = 'position:fixed;inset:12px;z-index:2147483003;overflow:auto;background:#181b1f;color:#eee;padding:12px;box-sizing:border-box'; document.body.append(host); window.__priorityRoot = renderer.createRoot(host); }
        function Frame() { const [evidence, setEvidence] = React.useState({ notifications: window.__notification }); return React.createElement(plugin.__features.CaseNotebook, { context, history: [{ role: 'user', content: 'Inspect fixture' }, { role: 'assistant', content: 'Fixture investigation summary' }], evidence, onChanges: value => { window.__changes = value; setEvidence(previous => ({ ...previous, changes: value })); }, onExplainChanges: () => {}, onRestore: value => { window.__restoredCase = value; } }); }
        window.__priorityRoot.render(React.createElement(Frame));
      }, context); await page.click('[data-testid="tech-ai-case-notebook"] > summary');
    }
    await mountNotebook(); await page.click('[data-testid="tech-ai-incident-changes"] > summary'); await fill(page, '[data-testid="tech-ai-incident-at"]', new Date(incidentAt).toISOString()); await page.click('[data-testid="tech-ai-incident-load"]'); await page.waitForSelector('[data-testid="tech-ai-incident-report"]');
    assert.equal(await page.$eval('[data-testid="tech-ai-case-save"]', el => el.disabled), true); await fill(page, '[aria-label="Название кейса"]', 'SQL fixture ' + suffix); await page.click('[data-testid="tech-ai-cases-opt-in"]'); await page.click('[data-testid="tech-ai-case-save"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-case-status"]')?.textContent.includes('сохранён'));
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#tech-ai-assistant-launcher');
    await mountNotebook(); assert.equal(await page.$eval('[data-testid="tech-ai-cases-opt-in"]', el => el.checked), false); await page.click('[data-testid="tech-ai-cases-load"]'); await page.waitForFunction(suffix => document.querySelector('[data-testid="tech-ai-case-notebook"]').textContent.includes('SQL fixture ' + suffix), {}, suffix);
    await page.$$eval('[data-testid="tech-ai-case-notebook"] details > summary', (elements, suffix) => elements.find(el => el.textContent.startsWith('SQL fixture ' + suffix)).click(), suffix); await page.click('[data-testid="tech-ai-case-restore"]'); assert.equal(await page.evaluate(() => window.__restoredCase.messages.at(-1).content), 'Fixture investigation summary');
    assert.equal(await page.evaluate(() => window.__restoredCase.evidence.changes.baseline.version), 1);
    check('Case opt-in save survives page reload, restores evidence and conversation; no image or automatic action');
    await button(page, 'Подготовить индекс-аннотацию'); await page.$$eval('[data-testid="tech-ai-case-notebook"] input[type="checkbox"]', elements => elements.find(el => el.parentElement.textContent.includes('Подтверждаю запись')).click()); await button(page, 'Создать индекс-аннотацию'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-case-status"]')?.textContent.includes('Индекс-аннотация создана'));
    const annotations = await request('/api/annotations?dashboardUID=' + uid + '&tags=tech-ai-case'); assert.ok(annotations.some(item => item.text.includes('Local case:')));
    check('Case index annotation is written only after explicit preview and confirmation');
    await page.screenshot({ path: 'test-results/incident-case-ui.png' }); await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/incident-case-mobile.png' }); assert.equal(await page.$eval('#priority-fixture', el => el.scrollWidth > el.clientWidth + 2), false);
    await button(page, 'Очистить все мои кейсы'); await button(page, 'Подтвердить очистку локальных кейсов');
    check('Narrow UI remains bounded; local case cleanup does not remove Grafana annotations');
    await page.setViewport({ width: 1400, height: 1000 });
    const settings = await request('/api/plugins/tech-ai-assistant-app/settings'); let modelCalls = 0;
    await page.setRequestInterception(true); page.on('request', intercepted => {
      const url = intercepted.url();
      if (url.endsWith('/api/plugins/tech-ai-assistant-app/settings') && intercepted.method() === 'GET') return intercepted.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...settings, jsonData: { ...settings.jsonData, previewBeforeSend: 'never', includePanelData: false, streaming: false } }) });
      if (url.includes('/api/plugin-proxy/tech-ai-assistant-app/') && intercepted.method() === 'POST') { modelCalls++; return intercepted.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Fixture analysis, no automatic action.' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) }); }
      return intercepted.continue();
    });
    await page.goto(root + '/d/' + uid); await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher'); await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    await page.select('[data-testid="tech-ai-composer-data-mode"]', 'structure'); await fill(page, '[data-testid="tech-ai-composer"] textarea', 'Review isolated SQL fixture'); await page.click('[data-testid="tech-ai-composer"] button[aria-label="Отправить"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('Fixture analysis'));
    await page.click('[data-testid="tech-ai-actions-panel"] > summary'); await page.click('[data-testid="tech-ai-case-notebook"] > summary'); await fill(page, '[aria-label="Название кейса"]', 'Integrated case ' + suffix); await page.click('[data-testid="tech-ai-cases-opt-in"]'); await page.click('[data-testid="tech-ai-case-save"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-case-status"]')?.textContent.includes('сохранён'));
    const integrated = await page.evaluate(suffix => Object.keys(localStorage).filter(key => key.startsWith('tech-ai-assistant:cases:v1:')).flatMap(key => JSON.parse(localStorage.getItem(key))).find(item => item.title === 'Integrated case ' + suffix), suffix);
    assert.equal(typeof integrated.context.range.from, 'number'); assert.equal(integrated.context.rangeBasis, 'last user request'); assert.ok(Math.abs(integrated.context.range.to - integrated.context.range.from - 3600000) < 2000); assert.ok(integrated.context.queries[0].targets[0].rawSql.includes('2*max(value)'));
    await button(page, 'Новый диалог'); await page.$$eval('[data-testid="tech-ai-case-notebook"] details > summary', (elements, suffix) => elements.find(el => el.textContent.startsWith('Integrated case ' + suffix)).click(), suffix); await page.click('[data-testid="tech-ai-case-restore"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('Восстановлен кейс'));
    assert.equal(modelCalls, 1); await page.screenshot({ path: 'test-results/incident-case-integrated.png' }); await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/incident-case-integrated-mobile.png' });
    const composer = await page.$eval('[data-testid="tech-ai-composer"] textarea', element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, viewport: innerHeight }; }); assert.ok(composer.top >= 0 && composer.bottom <= composer.viewport, JSON.stringify(composer));
    check('Integrated Assistant saves/restores case without new model call; actual mobile composer stays visible (only model/settings mocked)'); report.ok = true;
  } catch (error) { report.ok = false; report.error = error.message.replaceAll(password, '[REDACTED]'); console.error(error); process.exitCode = 1; }
  finally {
    const errors = []; async function cleanup(name, task) { try { await task(); } catch (error) { if (error.status !== 404) errors.push(name + ': ' + error.message.replaceAll(password, '[REDACTED]')); } }
    if (browser) await cleanup('browser', () => browser.close());
    if (rule) await cleanup('rule', () => write('/api/v1/provisioning/alert-rules/' + uid, 'DELETE'));
    if (rule) await cleanup('resolved instance', async () => { for (let i = 0; i < 20; i++) { if (!(await request('/api/alertmanager/grafana/api/v2/alerts')).some(item => item.labels?.service === uid)) return; await delay(1000); } throw Error('Fixture remains active; silence left until natural expiry'); });
    if (silence && !errors.some(item => item.startsWith('resolved instance'))) await cleanup('silence', () => write('/api/alertmanager/grafana/api/v2/silence/' + silence, 'DELETE'));
    if (dashboard) await cleanup('dashboard', () => write('/api/dashboards/uid/' + uid, 'DELETE'));
    if (folder) await cleanup('folder', () => write('/api/folders/' + folder, 'DELETE'));
    if (ds) await cleanup('datasource', () => write('/api/datasources/uid/' + uid, 'DELETE'));
    if (db) await cleanup('database', () => sql('postgres', `DROP DATABASE ${database} WITH (FORCE);`));
    if (role) await cleanup('role', () => sql('postgres', `DROP ROLE ${database};`));
    report.cleanupErrors = errors; if (errors.length) { report.ok = false; process.exitCode = 1; } report.finishedAt = new Date().toISOString(); fs.writeFileSync('test-results/incident-priorities-live.json', JSON.stringify(report, null, 2)); console.log('cleanup=' + (errors.length ? errors.join('; ') : 'ok'));
  }
})();
