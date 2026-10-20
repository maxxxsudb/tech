const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const container = process.env.POSTGRES_TEST_CONTAINER || 'voice2price-pilot-postgres-1';
const root = process.env.GRAFANA_TEST_URL || 'http://localhost:3300/crf/dashboard';
const network = 'tech-ai-test';
const suffix = Date.now().toString(36);
const database = 'tech_ai_verify_' + suffix;
const uid = 'ai-pg-' + suffix;
const password = crypto.randomBytes(24).toString('hex');
const auth = 'Basic ' + Buffer.from((process.env.GRAFANA_TEST_USER || 'admin') + ':' + (process.env.GRAFANA_TEST_PASSWORD || 'admin')).toString('base64');
const report = { startedAt: new Date().toISOString(), container, checks: [] };
const createdBuilderRules = [];
const docker = args => cp.execFileSync('docker', args, { encoding: 'utf8', windowsHide: true });
let owner, browser, folderUid, dbCreated = false, roleCreated = false, datasourceCreated = false, ruleCreated = false, dashboardCreated = false, connected = false;
function sql(db, text) {
  return cp.execFileSync('docker', ['exec', '-i', container, 'psql', '-U', owner, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At'], { input: text, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function api(route, method = 'GET', body) {
  const response = await fetch(root + route, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const result = text ? JSON.parse(text) : undefined;
  if (!response.ok && !(route === '/api/v1/eval' && result?.results)) throw Error(method + ' ' + route + ': ' + response.status + ' ' + text.slice(0, 300));
  return result;
}
function check(name) { report.checks.push(name); console.log('PASS ' + name); }

(async () => {
  try {
    const info = JSON.parse(docker(['inspect', container]))[0];
    assert.match(info.Config.Image, /^postgres:/);
    owner = (info.Config.Env.find(item => item.startsWith('POSTGRES_USER=')) || 'POSTGRES_USER=postgres').split('=')[1];
    if (!info.State.Running) docker(['start', container]);
    for (let attempt = 0; ; attempt++) {
      try { report.postgres = sql('postgres', 'SELECT version();').trim(); break; }
      catch (error) { if (attempt >= 29) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    if (!info.NetworkSettings.Networks[network]) { docker(['network', 'connect', network, container]); connected = true; }
    sql('postgres', `CREATE ROLE ${database} LOGIN PASSWORD '${password}';`); roleCreated = true;
    sql('postgres', `CREATE DATABASE ${database};`); dbCreated = true;
    sql('postgres', `REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${database};`);
    const to = Math.floor(Date.now() / 60000) * 60000, from = to - 3600000;
    sql(database, `CREATE TABLE orders (created_at timestamptz, amount numeric(16,5), service text);
      INSERT INTO orders VALUES (to_timestamp(${to - 600000}/1000.0),1234.56789,'api'),(to_timestamp(${to - 300000}/1000.0),999.99,'worker'),(to_timestamp(${to - 120000}/1000.0),NULL,'O''Reilly'),(to_timestamp(${from - 60000}/1000.0),7777,'api');
      CREATE TABLE customers (id integer, region text, PRIMARY KEY (id,region)); INSERT INTO customers VALUES (1,'eu');
      ALTER TABLE orders ADD COLUMN customer_id integer DEFAULT 1, ADD COLUMN region text DEFAULT 'eu', ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id,region) REFERENCES customers(id,region);
      CREATE INDEX orders_created_at_idx ON orders(created_at);
      CREATE TABLE "Odd's Table" ("MixedCase" integer);
      CREATE TABLE alert_samples (time timestamptz, value double precision);
      INSERT INTO alert_samples SELECT to_timestamp((${to} + i*60000)/1000.0), CASE WHEN i=-30 THEN 100 ELSE 5 END FROM generate_series(-90,1) AS i;
      GRANT USAGE ON SCHEMA public TO ${database}; GRANT SELECT ON orders,customers,alert_samples,"Odd's Table" TO ${database};`);
    report.grafana = (await api('/api/health')).version;
    assert.equal(report.grafana, '13.2.2');
    await api('/api/datasources', 'POST', { uid, name: 'Temporary SQL verification ' + suffix, type: 'grafana-postgresql-datasource', access: 'proxy', url: container + ':5432', user: database, jsonData: { database, sslmode: 'disable', postgresVersion: 1600, timescaledb: false }, secureJsonData: { password } });
    datasourceCreated = true;
    const health = await api('/api/datasources/uid/' + uid + '/health'); assert.equal(health.status, 'OK');
    check('Grafana connects to existing PostgreSQL using a temporary SELECT-only role');
    folderUid = (await api('/api/folders', 'POST', { title: 'Temporary SQL verification ' + suffix })).uid;
    const datasource = { uid, type: 'grafana-postgresql-datasource' };
    const target = { refId: 'A', datasource, rawSql: 'SELECT created_at, amount, service FROM orders WHERE $__timeFilter(created_at) ORDER BY amount DESC NULLS LAST', format: 'table', rawQuery: true, editorMode: 'code' };
    await api('/api/dashboards/db', 'POST', { folderUid, dashboard: { uid, title: 'Temporary PostgreSQL verification', schemaVersion: 41, time: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, templating: { list: [{ name: 'service', type: 'custom', query: "api,worker,O'Reilly", multi: true, includeAll: true, current: { text: ['api', "O'Reilly"], value: ['api', "O'Reilly"] }, options: ['api', 'worker', "O'Reilly"].map(value => ({ text: value, value, selected: value !== 'worker' })) }] }, panels: [{ id: 1, title: 'Orders SQL', type: 'table', datasource, targets: [target], gridPos: { x: 0, y: 0, w: 24, h: 8 } }] } });
    dashboardCreated = true;
    const sqlRule = { ...target, format: 'time_series', rawSql: 'SELECT $__timeGroupAlias(created_at,\'1m\'), sum(amount)::double precision AS value FROM orders WHERE $__timeFilter(created_at) GROUP BY 1 ORDER BY 1' };
    await api('/api/v1/provisioning/alert-rules', 'POST', { uid, orgID: 1, folderUID: folderUid, ruleGroup: 'SQL verification', title: 'Temporary paused SQL alert', condition: 'C', data: [{ refId: 'A', datasourceUid: uid, relativeTimeRange: { from: 600, to: 0 }, model: sqlRule }, { refId: 'B', datasourceUid: '__expr__', relativeTimeRange: { from: 0, to: 0 }, model: { refId: 'B', type: 'reduce', reducer: 'last', expression: 'A', datasource: { uid: '__expr__', type: '__expr__' } } }, { refId: 'C', datasourceUid: '__expr__', relativeTimeRange: { from: 0, to: 0 }, model: { refId: 'C', type: 'threshold', expression: 'B', conditions: [{ evaluator: { type: 'gt', params: [1000] } }], datasource: { uid: '__expr__', type: '__expr__' } } }], noDataState: 'NoData', execErrState: 'Error', for: '0s', isPaused: true });
    ruleCreated = true;
    const savedRule = await api('/api/v1/provisioning/alert-rules/' + uid);
    const evalData = structuredClone(savedRule.data);
    evalData[0].relativeTimeRange = { from: 3600, to: 0 };
    evalData[0].model.rawSql = 'SELECT now() AS time, sum(amount)::double precision AS value FROM orders WHERE $__timeFilter(created_at)';
    const firing = await api('/api/v1/eval', 'POST', { condition: 'C', data: evalData, now: new Date(to).toISOString() });
    const normalData = structuredClone(evalData); normalData[2].model.conditions[0].evaluator.params = [5000];
    const normal = await api('/api/v1/eval', 'POST', { condition: 'C', data: normalData, now: new Date(to).toISOString() });
    report.evaluation = { firing, normal };
    const conditionValue = result => result.results?.C?.frames?.[0]?.data?.values?.[0]?.[0];
    assert.equal(conditionValue(firing), 1, JSON.stringify(firing)); assert.equal(conditionValue(normal), 0, JSON.stringify(normal));
    check('Grafana evaluates real SQL + reduce + threshold: firing=1 and normal=0, rule stays paused');
    const emptyData = structuredClone(evalData);
    emptyData[0].model.rawSql = 'SELECT created_at AS time, amount::double precision AS value FROM orders WHERE false';
    const noData = await api('/api/v1/eval', 'POST', { condition: 'C', data: emptyData, now: new Date(to).toISOString() });
    const invalidData = structuredClone(evalData); invalidData[0].model.rawSql = 'SELECT missing_column FROM orders';
    const queryError = await api('/api/v1/eval', 'POST', { condition: 'C', data: invalidData, now: new Date(to).toISOString() });
    Object.assign(report.evaluation, { noData, queryError });
    assert.ok(noData.results?.A?.frames?.every(frame => frame.data.values.every(values => values.length === 0)), JSON.stringify(noData));
    assert.notEqual(conditionValue(noData), 0, JSON.stringify(noData));
    assert.match(queryError.results?.A?.error || '', /missing_column/, JSON.stringify(queryError));
    assert.notEqual(conditionValue(queryError), 0, JSON.stringify(queryError));
    assert.equal((await api('/api/v1/provisioning/alert-rules/' + uid)).isPaused, true);
    check('Alert evaluation preserves NoData and SQL error instead of reporting a normal condition');
    browser = await puppeteer.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage(); page.setDefaultTimeout(30000);
    await page.setCacheEnabled(false);
    await page.goto(root + '/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ({ user, password }) => { const r = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password }) }); if (!r.ok) throw Error('Login: ' + r.status); }, { user: process.env.GRAFANA_TEST_USER || 'admin', password: process.env.GRAFANA_TEST_PASSWORD || 'admin' });
    await page.goto(root + '/d/' + uid + '?var-service=api&var-service=O%27Reilly', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher');
    await page.waitForFunction(() => document.body.textContent.includes('Orders SQL'));
    const builder = await page.evaluate(async ({ uid, folderUid, to }) => {
      const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const domain = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/alerting.js');
      const tools = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/query-tools.js');
      const source = { datasource: { uid, type: 'grafana-postgresql-datasource' }, rawSql: 'SELECT $__timeTo()::timestamptz AS time, max(value)::double precision AS value FROM alert_samples WHERE $__timeFilter(time)' };
      const draft = { uid: uid + '-builder', title: 'Temporary builder SQL rule', folderUID: folderUid, ruleGroup: 'SQL verification', source, reducer: 'max', operator: 'gt', threshold: 50, for: '2m', intervalSeconds: 60, lookbackSeconds: 300, labels: { service: 'fixture', team: 'test', severity: 'warning' }, annotations: { summary: 'Live builder verification' } };
      const rule = domain.buildRule(draft, tools.boundedSql);
      const request = plugin.__features.grafanaRequest;
      const group = await domain.verifyGroup(request, rule, 60);
      const preview = await domain.previewRule(request, rule);
      const plan = domain.planReplay(rule, 60, to - 35 * 60000, to - 15 * 60000);
      const replay = await domain.replayRule(request, rule, plan, { thresholds: [50,150], pending: [0,120] });
      window.__builderFixture = { rule, preview, replay, groupCount: group.rules };
      return { rule, preview, replay, group };
    }, { uid, folderUid, to });
    report.builder = builder;
    assert.equal(builder.preview.status, 'ok', JSON.stringify(builder.preview)); assert.equal(builder.replay.coverage, 1, JSON.stringify(builder.replay));
    assert.equal(builder.replay.plan.evaluations, 21); assert.equal(builder.replay.statistics.firingEpisodes, 1);
    assert.equal(builder.replay.statistics.episodes[0].start, to - 28 * 60000);
    assert.equal(builder.replay.statistics.episodes[0].end, to - 24 * 60000);
    assert.equal(builder.replay.statistics.longestObservedMs, 4 * 60000);
    assert.equal(builder.replay.variants.find(v => v.threshold === 150).statistics.firingEpisodes, 0);
    assert.deepEqual(builder.replay.points.filter(p => p.result.samples[0].value === 100).map(p => p.at), Array.from({length:6}, (_,i) => to - (30-i)*60000));
    check('Deterministic builder preview and true rolling SQL replay: 21 backend evaluations, spike window/pending/episode boundaries match exact fixture');
    createdBuilderRules.push(builder.rule.uid);
    const created = await page.evaluate(async () => {
      const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const domain = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/alerting.js');
      const { rule, preview, replay, groupCount } = window.__builderFixture;
      const result = await domain.createPaused(plugin.__features.grafanaRequest, rule, { preview, replay, groupCount }, { confirmed: true, role: 'Admin' });
      const retry = await domain.createPaused(plugin.__features.grafanaRequest, rule, { preview, replay, groupCount }, { confirmed: true, role: 'Admin' });
      return { result, retry };
    });
    assert.equal(created.result.rule.isPaused, true); assert.equal(created.retry.alreadyCreated, true);
    assert.equal((await api('/api/v1/provisioning/alert-rules/' + created.result.rule.uid)).isPaused, true);
    check('Actual POST creates only paused rule; repeated same UID reconciles without another write or group overwrite');
    const result = await page.evaluate(async ({ datasource, target, from, to, uid }) => {
      const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const runtime = await System.import('@grafana/runtime');
      const ds = await runtime.getDataSourceSrv().get(datasource);
      const settings = { ...plugin.__test.defaults, allowedDatasourceUids: uid };
      const context = { panels: [{ id: 1, title: 'Orders SQL', datasource, targets: [target] }], timeRange: { from, to } };
      const sample = async query => plugin.__test.loadPanelData(settings, { ...context, panels: [{ ...context.panels[0], targets: [{ ...target, ...query }] }] }, { sampleRows: 2 });
      const table = await sample({});
      const series = await sample({ format: 'time_series', rawSql: "SELECT $__timeGroupAlias(created_at,'1m'), sum(amount)::double precision AS value FROM orders WHERE $__timeFilter(created_at) GROUP BY 1 ORDER BY 1" });
      const variables = await sample({ rawSql: 'SELECT service FROM orders WHERE $__timeFilter(created_at) AND service IN (${service:sqlstring}) ORDER BY service' });
      const nullable = await sample({ rawSql: 'SELECT created_at, amount FROM orders WHERE amount IS NULL' });
      const interval = await sample({ rawSql: "SELECT $__timeGroupAlias(created_at,$__interval), sum(amount)::double precision AS value FROM orders WHERE $__timeFilter(created_at) GROUP BY 1 ORDER BY 1", format: 'time_series' });
      const empty = await sample({ rawSql: 'SELECT created_at, amount FROM orders WHERE false' });
      const error = await sample({ rawSql: 'SELECT missing_column FROM orders' });
      const denied = await sample({ rawSql: 'UPDATE orders SET amount=0 RETURNING amount' });
      const validation = await plugin.__features.validateDashboardProposal(settings, context, { panelId: 1, selectedTargets: { ids: ['A'], targets: [{ refId: 'A', rawSql: 'SELECT created_at, amount FROM orders WHERE $__timeFilter(created_at) ORDER BY amount DESC NULLS LAST' }] } });
      const schema = {};
      for (const action of ['tables', 'columns', 'foreign_keys', 'indexes']) schema[action] = await plugin.__features.executeSchemaTool(settings, context, { datasourceUid: uid, action, schema: 'public', table: 'orders' });
      schema.quoted = await plugin.__features.executeSchemaTool(settings, context, { datasourceUid: uid, action: 'columns', schema: 'public', table: "Odd's Table" });
      const bounded = await plugin.__features.executeQueryTool(settings, context, { datasourceUid: uid, rowLimit: 2, query: { rawSql: 'SELECT generate_series(1,5) AS n', format: 'table' } });
      const sqlSeries = await plugin.__features.executeQueryTool(settings, context, { datasourceUid: uid, query: { rawSql: "SELECT $__timeGroupAlias(created_at,'1m'), sum(amount)::double precision AS value FROM orders WHERE $__timeFilter(created_at) GROUP BY 1 ORDER BY 1", format: 'time_series' } });
      let blocked = false;
      try { await plugin.__features.executeQueryTool(settings, context, { datasourceUid: uid, query: { rawSql: 'DELETE FROM orders' } }); } catch (_) { blocked = true; }
      let round = 0; const repairRequests = [];
      const repair = await plugin.__test.runAssistant({ ...settings, toolsMode: 'text' }, context, JSON.stringify(context), [{ role: 'user', content: 'Fix SQL using the actual schema' }], {
        queries: true, schema: true,
        post: async (_settings, body) => {
          repairRequests.push(body);
          const content = [
            '```grafana-query\n' + JSON.stringify({ datasourceUid: uid, query: { rawSql: 'SELECT missing_column FROM orders' }, reason: 'Check column' }) + '\n```',
            '```grafana-schema\n' + JSON.stringify({ datasourceUid: uid, action: 'columns', schema: 'public', table: 'orders', reason: 'Read real columns after 42703' }) + '\n```',
            '```grafana-query\n' + JSON.stringify({ datasourceUid: uid, query: { rawSql: 'SELECT amount FROM orders WHERE $__timeFilter(created_at) ORDER BY amount DESC NULLS LAST' }, reason: 'Use real amount column' }) + '\n```',
            'Corrected SQL using real metadata and query results.'
          ][round++]; return { content, toolCalls: [] };
        }
      });
      const React = await System.import('react'), ReactDOM = await System.import('react-dom/client');
      const mount = document.createElement('div'); mount.id = 'sql-explore-verification'; document.body.appendChild(mount);
      const reactRoot = ReactDOM.createRoot(mount);
      reactRoot.render(React.createElement(plugin.__features.CodeBlock, { lang: 'sql', code: 'SELECT service FROM orders WHERE service IN (${service:sqlstring})', context: { ...context, variables: { service: ['api', "O'Reilly"] } } }));
      const deadline = Date.now() + 10000;
      while (!mount.querySelector('a')) { if (Date.now() > deadline) throw Error('SQL Explore link not rendered'); await new Promise(resolve => setTimeout(resolve, 50)); }
      const exploreLink = mount.querySelector('a').href; reactRoot.unmount(); mount.remove();
      return { table, series, variables, nullable, interval, empty, error, denied, validation, schema, bounded, sqlSeries, blocked, repair, exploreLink, pluginVersion: plugin.__test.diagnosticPayload(settings).plugin.version, repairSawSqlState: JSON.stringify(repairRequests[1]).includes('42703'), datasourceInterpolation: typeof ds.interpolateVariablesInQueries };
    }, { datasource, target, from, to, uid });
    report.results = result;
    report.pluginVersion = result.pluginVersion; assert.equal(report.pluginVersion, require('../plugin/plugin.json').info.version);
    const table = result.table[0].results?.[0]?.result; assert.ok(table?.tables, JSON.stringify(result.table));
    assert.equal(table.tables[0].totalRows, 3); assert.equal(table.tables[0].truncated, true);
    assert.equal(table.tables[0].rows[0][1], 1234.56789); assert.equal(table.tables[0].rows[1][1], 999.99);
    assert.equal(table.tables[0].rows[0][0], new Date(to - 600000).toISOString());
    check('Real SQL table: timeFilter, ORDER BY, decimals, timestamps and sampling');
    assert.ok(result.series[0].results?.[0]?.result.series?.length, JSON.stringify(result.series));
    check('Real SQL time_series with timeGroupAlias');
    assert.deepEqual(result.variables[0].results?.[0]?.result.tables?.[0]?.rows, [["O'Reilly"], ['api']], JSON.stringify(result.variables));
    check('Actual Grafana datasource interpolation: multivalue and SQL quote escaping');
    assert.equal(result.nullable[0].results?.[0]?.result.tables?.[0]?.rows[0][1], null);
    assert.equal(result.series[0].results[0].result.series[0].nulls, 1);
    assert.equal(result.empty[0].results?.[0]?.result.tables?.[0]?.totalRows, 0);
    assert.equal(result.empty[0].results[0].result.error, undefined);
    check('SQL NULL remains null; empty selection remains zero rows without an error');
    assert.ok(result.interval[0].results?.[0]?.result.series?.length, JSON.stringify(result.interval));
    check('Grafana interval macro with SQL grouping');
    assert.ok(result.error[0].results?.[0]?.result.error?.includes('missing_column'), JSON.stringify(result.error));
    assert.ok(result.denied[0].results?.[0]?.result.error?.includes('permission denied'), JSON.stringify(result.denied));
    check('Real datasource errors and denied write remain errors');
    assert.equal(result.validation.ok, true, JSON.stringify(result.validation)); assert.equal(result.validation.details[0].rows, 3); assert.equal(result.validation.details[0].series, 0);
    check('Partial SQL proposal validation retains original table format');
    assert.ok(result.schema.tables.items.some(item => item.table_name === 'orders'));
    assert.equal(result.schema.columns.items.find(item => item.column_name === 'amount').numeric_scale, 5);
    assert.deepEqual(result.schema.foreign_keys.items.map(item => [item.column_name, item.referenced_column]), [['customer_id', 'id'], ['region', 'region']]);
    assert.ok(result.schema.indexes.items.some(item => item.indexname === 'orders_created_at_idx'));
    assert.equal(result.schema.quoted.items[0].column_name, 'MixedCase');
    check('PostgreSQL metadata: real tables, column precision, composite foreign keys and indexes using SELECT-only role');
    assert.equal(result.bounded.results[0].result.sqlRows.truncated, true);
    assert.deepEqual(result.bounded.results[0].result.tables[0].rows, [[1], [2]]); assert.equal(result.blocked, true);
    assert.equal(result.repairSawSqlState, true); assert.equal(result.repair.steps.length, 3);
    assert.ok(result.repair.steps[0].error.includes('missing_column')); assert.equal(result.repair.steps[1].kind, 'schema'); assert.equal(result.repair.steps[2].error, undefined);
    check('Actual SQL tool bounds data and blocks DML; assistant loop receives 42703, reads schema and runs corrected SQL (model scripted)');
    assert.equal(result.sqlSeries.results[0].result.series[0].max, 1234.56789);
    check('Bounded SQL tool preserves time_series macros, decimal statistics and temporal ordering');
    const exploreQuery = JSON.parse(new URL(result.exploreLink).searchParams.get('panes')).a.queries[0];
    assert.equal(exploreQuery.format, 'table'); assert.equal(exploreQuery.datasource.uid, uid);
    assert.ok(exploreQuery.rawSql.includes("'api','O''Reilly'"), exploreQuery.rawSql);
    check('SQL code block opens Explore with rawSql, original datasource/range and resolved dashboard variables');
    await page.goto(root + '/d/' + uid + '?var-service=All', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher');
    const all = await page.evaluate(async ({ datasource, target, from, to }) => {
      const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const runtime = await System.import('@grafana/runtime');
      const started = Date.now();
      while (!runtime.getTemplateSrv().getVariables().some(item => item.name === 'service' && item.current?.value?.includes('$__all'))) {
        if (Date.now() - started > 15000) throw Error('All variable not loaded');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return plugin.__test.loadPanelData(plugin.__test.defaults, { panels: [{ id: 1, datasource, targets: [{ ...target, rawSql: 'SELECT service FROM orders WHERE $__timeFilter(created_at) AND service IN (${service:sqlstring}) ORDER BY service' }] }], timeRange: { from, to } });
    }, { datasource, target, from, to });
    report.all = all;
    assert.deepEqual(all[0].results?.[0]?.result.tables?.[0]?.rows, [["O'Reilly"], ['api'], ['worker']], JSON.stringify(all));
    check('Actual Grafana All variable expands to all SQL-escaped values');
    await page.goto(root + '/alerting/grafana/' + uid + '/view', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher');
    const alert = await page.evaluate(async () => {
      const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const context = await plugin.__features.loadContext();
      const data = await plugin.__test.loadPanelData(plugin.__test.defaults, context, { sampleRows: 2 });
      return { context, data };
    });
    assert.equal(alert.context.alerting.rule.isPaused, true); assert.equal(alert.context.dashboardUid, undefined);
    assert.equal(alert.context.panels[0].targets.length, 1); assert.equal(alert.context.panels[0].targets[0].datasource.uid, uid);
    assert.ok(alert.data[0].results?.[0]?.result.series?.length, JSON.stringify(alert.data));
    report.alert = alert;
    check('Real paused SQL alert without linked dashboard: rule API, datasource resolution and SQL resampling');
    const audit = await page.evaluate(async () => {
      const plugin = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const alerting = await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/alerting.js');
      return alerting.readAudit(plugin.__features.grafanaRequest);
    });
    const auditedRule = audit.rules.find(rule => rule.uid === uid);
    assert.ok(auditedRule.issues.some(issue => issue.code === 'annotation_runbook_url'));
    assert.equal(audit.readStatus.policies.ok, true); assert.equal(audit.readStatus.contacts.ok, true); assert.equal(audit.readStatus.timings.ok, true);
    report.audit = audit;
    check('Live alert audit reads actual rules/policies/contacts/mute timings and returns evidence without writes');
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('[data-testid="tech-ai-alert-context"]');
    assert.equal(await page.$eval('[data-testid="tech-ai-alert-context"] details', node => node.open), false);
    await page.evaluate(() => document.querySelector('[data-testid="tech-ai-alert-context"] details').open = true);
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="tech-ai-alert-audit"] button')].find(button => button.textContent === 'Проверить качество правил').click());
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-alert-audit"]')?.textContent.includes('Проверено правил:'));
    await page.type('[aria-label="Фильтр правил"]', 'Temporary paused SQL alert');
    assert.ok((await page.$eval('[data-testid="tech-ai-alert-audit"]', node => node.textContent)).includes('Temporary paused SQL alert'));
    const screenshotPath = path.resolve(__dirname, '../test-results/postgres-audit-ui.png');
    await page.setViewport({ width: 1400, height: 1000 }); await page.screenshot({ path: screenshotPath });
    check('Existing Alerting drawer exposes audit inside collapsed details; rule filter works in actual browser');
    await page.evaluate(() => {
      window.__auditDownloads = [];
      const original = URL.createObjectURL;
      URL.createObjectURL = blob => { window.__auditDownloads.push(blob); return original(blob); };
      document.addEventListener('click', event => { if (event.target.tagName === 'A' && event.target.download?.startsWith('grafana-alert-audit')) event.preventDefault(); }, true);
    });
    for (const label of ['JSON', 'Markdown']) await page.evaluate(label => [...document.querySelectorAll('[data-testid="tech-ai-alert-audit"] button')].find(button => button.textContent === label).click(), label);
    const downloads = await page.evaluate(() => Promise.all(window.__auditDownloads.map(blob => blob.text())));
    assert.ok(JSON.parse(downloads[0]).rules.some(rule => rule.uid === uid)); assert.ok(downloads[1].includes('evidence:'));
    check('Audit JSON and Markdown exports contain actual rule evidence');
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/postgres-audit-mobile.png') });
    const layout = await page.evaluate(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
      const composer = document.querySelector('[data-testid="tech-ai-composer"] textarea').getBoundingClientRect();
      return { drawerLeft: drawer.left, drawerRight: drawer.right, composerBottom: composer.bottom, composerTop: composer.top, width: innerWidth, height: innerHeight };
    });
    assert.ok(layout.drawerLeft >= -1 && layout.drawerRight <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.composerTop > 0 && layout.composerBottom <= layout.height, JSON.stringify(layout));
    check('Narrow viewport: audit remains scrollable and composer stays visible');
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(root + '/d/' + uid, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    const rulePosts = [], evalRequests = [];
    let denyCreate = false;
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname.endsWith('/api/v1/eval')) evalRequests.push(JSON.parse(request.postData()));
      if (request.method() === 'POST' && pathname.endsWith('/api/v1/provisioning/alert-rules')) {
        rulePosts.push(JSON.parse(request.postData()));
        if (denyCreate) return request.respond({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden fixture' }) });
      }
      return request.continue();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].some(button => button.textContent === 'Подготовить алерт' && !button.disabled));
    await page.evaluate(() => {
      document.querySelector('[data-testid="tech-ai-actions-panel"]').open = true;
      document.querySelector('[data-testid="tech-ai-more-actions"]').open = true;
      [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(button => button.textContent === 'Подготовить алерт').click();
    });
    await page.waitForSelector('[data-testid="tech-ai-alert-editor"]');
    assert.equal(evalRequests.length, 0); assert.equal(rulePosts.length, 0);
    const fill = async (selector, value) => { await page.click(selector); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.type(selector, value); };
    await fill('[data-testid="tech-ai-alert-title"]', 'Temporary UI builder alert');
    await fill('[data-testid="tech-ai-alert-threshold"]', '50');
    await fill('[data-testid="tech-ai-alert-for"]', '0s');
    await fill('[data-testid="tech-ai-alert-query"]', builder.rule.data[0].model.rawSql);
    await page.waitForFunction(folderUid => [...document.querySelector('[data-testid="tech-ai-alert-folder"]').options].some(option => option.value === folderUid), {}, folderUid);
    await page.select('[data-testid="tech-ai-alert-folder"]', folderUid);
    await page.select('[data-testid="tech-ai-alert-group"]', 'SQL verification');
    await page.waitForFunction(() => !document.querySelector('[data-testid="tech-ai-alert-preview"]').disabled);
    await page.click('[data-testid="tech-ai-alert-preview"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-alert-preview-result"]')?.getAttribute('data-status') === 'ok');
    await fill('[data-testid="tech-ai-alert-threshold"]', '51');
    assert.equal(await page.$('[data-testid="tech-ai-alert-preview-result"]'), null);
    await fill('[data-testid="tech-ai-alert-threshold"]', '50');
    await page.click('[data-testid="tech-ai-alert-preview"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-alert-preview-result"]')?.getAttribute('data-status') === 'ok');
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="tech-ai-alert-editor"] details')].find(node => node.querySelector('summary')?.textContent.startsWith('Проверка истории')).open = true);
    await page.click('[data-testid="tech-ai-alert-plan"]');
    await page.waitForSelector('[data-testid="tech-ai-alert-plan-summary"]');
    assert.equal(rulePosts.length, 0);
    await page.click('[data-testid="tech-ai-alert-replay"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-alert-replay-result"]')?.textContent.includes('покрытие 100.0%'), { timeout: 150000 });
    assert.equal(rulePosts.length, 0);
    await page.evaluate(() => { window.__draftExports = []; const original = URL.createObjectURL; URL.createObjectURL = blob => { window.__draftExports.push(blob); return original(blob); }; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { if (this.download === 'grafana-alert-draft.json') return; return click.call(this); }; });
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="tech-ai-alert-editor"] button')].find(button => button.textContent === 'Экспорт JSON').click());
    const exported = JSON.parse(await page.evaluate(() => window.__draftExports.at(-1).text()));
    createdBuilderRules.push(exported.rule.uid); assert.equal(exported.rule.isPaused, true);
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/alert-builder-ui.png') });
    await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: path.resolve(__dirname, '../test-results/alert-builder-mobile.png') });
    await page.setViewport({ width: 1400, height: 1000 });
    await page.click('[data-testid="tech-ai-alert-confirm"]'); denyCreate = true;
    await page.click('[data-testid="tech-ai-alert-create"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="tech-ai-alert-editor"] [role="alert"]')].some(node => /403|Forbidden/.test(node.textContent)));
    assert.equal(await page.$('[data-testid="tech-ai-alert-created"]'), null);
    denyCreate = false; await page.click('[data-testid="tech-ai-alert-create"]');
    await page.waitForSelector('[data-testid="tech-ai-alert-created"]');
    assert.equal((await api('/api/v1/provisioning/alert-rules/' + exported.rule.uid)).isPaused, true);
    assert.ok(rulePosts.every(rule => rule.isPaused === true && rule.uid === exported.rule.uid));
    const journal = await page.evaluate(uid => JSON.parse(localStorage.getItem('tech-ai-assistant:alert-audit:v1:1')).filter(item => item.uid === uid), exported.rule.uid);
    assert.ok(journal.some(item => item.status === 'verified'));
    report.builderUi = { uid: exported.rule.uid, evalRequests: evalRequests.length, creationPosts: rulePosts.length, auditStatuses: journal.map(item => item.status) };
    check('Existing Prepare alert action: no hidden eval/write, edits invalidate proof, explicit preview/replay/export, 403 stays error, confirmed create stays paused and audited');
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="tech-ai-alert-editor"] button')].find(button => button.textContent === 'Вернуться в чат').click());
    await page.waitForSelector('#tech-ai-assistant-drawer textarea');
    report.ok = true;
  } catch (error) {
    if (browser) { const pages = await browser.pages(); const last = pages.at(-1); await last?.screenshot({ path: path.resolve(__dirname, '../test-results/alert-builder-error.png') }).catch(() => {}); }
    report.ok = false; report.error = error.message.replaceAll(password, '[REDACTED]'); process.exitCode = 1;
    console.error(report.error);
  } finally {
    const cleanupErrors = [];
    for (const [enabled, name, action] of [
      [!!browser, 'browser', () => browser.close()],
      [true, 'builder rules', async () => { for (const ruleUid of createdBuilderRules) { const response = await fetch(root + '/api/v1/provisioning/alert-rules/' + ruleUid, { method: 'DELETE', headers: { Authorization: auth } }); if (!response.ok && response.status !== 404) throw Error('Rule cleanup: ' + response.status); } }],
      [ruleCreated, 'rule', () => api('/api/v1/provisioning/alert-rules/' + uid, 'DELETE')],
      [dashboardCreated, 'dashboard', () => api('/api/dashboards/uid/' + uid, 'DELETE')],
      [!!folderUid, 'folder', () => api('/api/folders/' + folderUid, 'DELETE')],
      [datasourceCreated, 'datasource', () => api('/api/datasources/uid/' + uid, 'DELETE')],
      [dbCreated, 'database', () => sql('postgres', `DROP DATABASE ${database} WITH (FORCE);`)],
      [roleCreated, 'role', () => sql('postgres', `DROP ROLE ${database};`)],
      [connected, 'network', () => docker(['network', 'disconnect', network, container])],
    ]) { if (enabled) try { await action(); } catch (error) { cleanupErrors.push(name + ': ' + error.message.replaceAll(password, '[REDACTED]')); } }
    report.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length) { process.exitCode = 1; report.ok = false; }
    report.finishedAt = new Date().toISOString();
    const output = path.resolve(__dirname, '../test-results/postgres-live.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log('Report: ' + output + '; cleanup=' + (cleanupErrors.length ? 'FAILED' : 'ok'));
  }
})();
