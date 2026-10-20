const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../plugin/alerting'), q = require('../plugin/query-tools'), c = require('../plugin/conversation');
let factory; global.define = (_deps, fn) => { factory = fn; }; delete require.cache[require.resolve('../plugin/module')]; require('../plugin/module'); delete global.define;
class AppPlugin { constructor() { const proxy = new Proxy(this, { get: () => () => proxy }); return proxy; } }
const runtime = { config: { appSubUrl: '/crf/dashboard', bootData: { user: { id: 1, orgId: 1, login: 'test', orgRole: 'Admin' } } } };
const f = factory({ AppPlugin, BusEventWithPayload: class {} }, runtime, { createElement: () => null }, {}, require('../plugin/attachments'), c, q, {}, a).__features;
const now = Date.parse('2026-10-19T09:00:00Z');
function evidence() { return { loadedAt: new Date(now).toISOString(), readStatus: { instances: { ok: true }, status: { ok: true }, timings: { ok: true } }, resources: { instances: [{ fingerprint: 'target', labels: { service: 'sql', severity: 'warning' }, receivers: [{ name: 'database' }], status: { state: 'suppressed', silencedBy: ['s1'], inhibitedBy: ['source'] } }, { fingerprint: 'source', labels: { service: 'sql', severity: 'critical' }, status: { state: 'active' } }], silences: [{ id: 's1', comment: 'maintenance', state: 'active' }], groups: [{ receiver: { name: 'database' }, fingerprints: ['target'] }], contacts: [{ name: 'default' }, { name: 'database' }], timings: [], effective: { route: { receiver: 'default', routes: [{ matchers: ['service="sql"'], receiver: 'database' }] }, contacts: [{ name: 'default' }, { name: 'database' }], timings: [] } } }; }
test('notification report uses exact instance labels, effective route, observed receivers and API suppression facts', () => {
  const report = a.notificationReport(evidence(), 'target', { now });
  assert.deepEqual(report.observedReceivers, ['database']); assert.equal(report.routing.routes[0].receiver, 'database'); assert.equal(report.routing.trace[0].match, true);
  assert.equal(report.silences[0].detail.comment, 'maintenance'); assert.equal(report.inhibitions[0].alert.fingerprint, 'source'); assert.equal(report.deliveryVerified, false); assert.equal(report.delivery, 'unknown'); assert.equal(report.findings.filter(item => item.kind === 'confirmed').length, 2);
});
test('routes preserve nested continue, fallback, inherited timer settings and missing-label semantics', () => {
  const route = { receiver: 'fallback', group_wait: '1m', group_interval: '3m', repeat_interval: '1h', routes: [{ matchers: ['x!=""'], receiver: 'ignored' }, { matchers: ['service="sql"'], receiver: 'a', continue: true, routes: [{ matchers: ['severity="critical"'], receiver: 'b' }] }, { matchers: ['service="sql"'], receiver: 'c' }] };
  const result = a.routePreview(route, { service: 'sql', severity: 'warning' }, [{ name: 'a' }, { name: 'b' }, { name: 'c' }], [], now);
  assert.deepEqual(result.routes.map(item => item.receiver), ['a', 'c']); assert.equal(result.routes[0].fallback, true); assert.equal(result.routes[0].groupWait, '1m'); assert.equal(result.trace[0].match, false);
});
test('complex regex is unknown without inventing destination; observed receiver remains available', () => {
  const e = evidence(); e.resources.effective.route.routes[0].matchers = ['service=~"(sql|db)+"'];
  const report = a.notificationReport(e, 'target', { now }); assert.equal(report.routing.status, 'partial'); assert.equal(report.routing.routes.length, 0); assert.deepEqual(report.observedReceivers, ['database']);
  const dangerous = a.routePreview({ receiver: 'x', routes: [{ matchers: ['x=~".*.*.*.*.*.*Z"'] }] }, { x: 'a'.repeat(500) }, [], [], now); assert.equal(dangerous.status, 'partial');
});
test('mute/active intervals use snapshot time; absence of reason never claims delivery; stale snapshot rejected', () => {
  const e = evidence(); e.resources.instances[0].status = { state: 'active', silencedBy: [], inhibitedBy: [] }; e.resources.effective.route.routes[0].mute_time_intervals = ['window']; e.resources.timings = [{ name: 'window', time_intervals: [{ times: [{ start_time: '08:00', end_time: '10:00' }], location: 'UTC' }] }];
  let report = a.notificationReport(e, 'target', { now: now + 60000 }); assert.equal(report.routing.routes[0].muted, true); assert.ok(report.findings.some(item => item.kind === 'calculated'));
  e.resources.timings = []; e.resources.effective.route.routes[0].mute_time_intervals = []; report = a.notificationReport(e, 'target', { now }); assert.ok(report.findings.some(item => /не найдена/.test(item.text))); assert.equal(report.deliveryVerified, false);
  assert.throws(() => a.notificationReport(e, 'target', { now: now + 6 * 60000 }), /устарел/); assert.throws(() => a.notificationReport(e, 'vanished', { now }), /отсутствует/);
});
test('read notification evidence only GETs, strips receiver credentials and preserves partial/403 states', async () => {
  const paths = [];
  const result = await a.readNotificationEvidence(async (path, options) => { paths.push(path); assert.equal(options.method, undefined); if (path.endsWith('/status')) return { config: { route: { receiver: 'cp' }, receivers: [{ name: 'cp', password: 'LEAK', grafana_managed_receiver_configs: [{ settings: { token: 'LEAK' } }] }] } }; if (path.endsWith('/policies')) throw { status: 403 }; if (path.endsWith('/contact-points')) return [{ name: 'cp', type: 'email', settings: { addresses: 'LEAK' } }]; return []; }, { now });
  assert.equal(paths.length, 7); assert.equal(result.readStatus.policies.status, 403); assert.ok(!JSON.stringify(result).includes('LEAK')); assert.equal(result.resources.effective.contacts[0].name, 'cp');
  const controller = new AbortController(); controller.abort(); await assert.rejects(a.readNotificationEvidence(async () => { throw new DOMException('Abort', 'AbortError'); }, { signal: controller.signal }), { name: 'AbortError' });
});
function dash(version, sql) { return { uid: 'd', version, title: 'Dashboard', panels: [{ id: 1, title: 'SQL', datasource: { uid: 'pg', type: 'grafana-postgresql-datasource' }, targets: [{ refId: 'A', rawSql: sql }] }], templating: { list: [{ name: 'service', query: 'api,db', current: { value: version === 1 ? 'api' : 'db' } }] } }; }
test('dashboard diff detects multiline SQL, added/removed/nested panels, datasource, unit and variables', () => {
  const before = dash(1, 'SELECT 1\nFROM samples'), after = dash(2, 'SELECT 2\nFROM samples');
  before.panels.push({ id: 3, title: 'removed' }); after.panels.push({ id: 4, title: 'row', panels: [{ id: 5, title: 'new nested' }] }); after.panels[0].fieldConfig = { defaults: { unit: 'percent' } };
  const diff = q.dashboardDiff(before, after); assert.equal(diff.totalChangedPanels, 4); assert.ok(diff.panels[0].queries[0].lines.some(line => line.type === 'add' && line.text === 'SELECT 2')); assert.ok(diff.variables); assert.ok(diff.panels.find(panel => panel.panelId === '3').kind === 'removed');
  assert.equal(q.dashboardDiff(after, structuredClone(after)).totalChangedPanels, 0);
});
const originalFetch = global.fetch; test.after(() => { global.fetch = originalFetch; });
test('incident changes select saved version before startsAt, not arbitrary previous; read-only and race guarded', async () => {
  const calls = [], current = dash(3, 'SELECT 3'); const versions = [{ version: 3, created: '2026-10-19T08:30:00Z' }, { version: 2, created: '2026-10-19T08:20:00Z' }, { version: 1, created: '2026-10-19T08:00:00Z' }];
  global.fetch = async (path, options) => { calls.push(path); assert.equal(options.method, 'GET'); const value = path.includes('/versions?') ? versions : path.endsWith('/versions/1') ? { data: dash(1, 'SELECT 1') } : { dashboard: current }; return new Response(JSON.stringify(value)); };
  const report = await f.readIncidentChanges({ dashboardUid: 'd' }, { incidentAt: Date.parse('2026-10-19T08:10:00Z') }); assert.equal(report.baseline.version, 1); assert.equal(report.currentVersion, 3); assert.equal(calls.length, 4); assert.ok(report.diff.panels.length);
  await assert.rejects(f.readIncidentChanges({ dashboardUid: 'd' }, { incidentAt: Date.parse('2026-10-19') }), /не найдена/);
  let currentReads = 0; global.fetch = async path => new Response(JSON.stringify(path.includes('/versions?') ? versions : path.includes('/versions/') ? { data: dash(2, 'SELECT 2') } : { dashboard: { ...current, version: ++currentReads > 1 ? 4 : 3 } }));
  await assert.rejects(f.readIncidentChanges({ dashboardUid: 'd' }), /изменился/);
});
test('incident changes handle 403/unknown dates/no dashboard instead of inventing empty diff', async () => {
  await assert.rejects(f.readIncidentChanges({}), /связанный/);
  global.fetch = async () => new Response('{"message":"Forbidden"}', { status: 403 }); await assert.rejects(f.readIncidentChanges({ dashboardUid: 'd' }), { status: 403 });
  global.fetch = async path => new Response(JSON.stringify(path.includes('/versions?') ? [{ version: 3, created: 'unknown' }] : { dashboard: dash(3, 'SELECT 3') })); await assert.rejects(f.readIncidentChanges({ dashboardUid: 'd' }, { incidentAt: now }), /неизвестные даты/);
});
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const record = id => ({ schemaVersion: 1, id: id || 'case-1', title: 'SQL incident', updatedAt: new Date(now).toISOString(), context: { dashboardUid: 'd', pageType: 'dashboard', range: { from: 1, to: 2 } }, evidence: { source: 'test', password: 'LEAK' }, messages: [{ role: 'user', content: 'Query', attachments: [{ dataUrl: 'data:image/png;base64,AAAA' }] }, { role: 'assistant', content: 'Finding', images: ['LEAK'], action: { queries: true }, modelContent: 'LEAK' }] });
test('cases require explicit opt-in; round trip excludes images/commands/secrets and isolates org/user/context', () => {
  const storage = memory(), key = c.caseScope(1, 1); assert.throws(() => c.storeCase(storage, key, record(), false), /Разрешите/); assert.equal(storage.getItem(key), null);
  c.storeCase(storage, key, record(), true); let saved = c.readCases(storage, key)[0]; assert.equal(saved.evidence.password, '[REDACTED]'); assert.ok(!JSON.stringify(saved).includes('LEAK')); assert.ok(!('attachments' in saved.messages[0]));
  assert.equal(c.readCases(storage, c.caseScope(2, 1)).length, 0); assert.equal(c.readCases(storage, c.caseScope(1, 2)).length, 0); assert.equal(c.caseCompatible(saved, { dashboardUid: 'd' }), true); assert.equal(c.caseCompatible(saved, { dashboardUid: 'other' }), false); assert.equal(c.caseCompatible(saved, { dashboardUid: 'd', isAlerting: true, alerting: { ruleUid: 'a' } }), false);
  saved.title = 'Renamed'; c.storeCase(storage, key, saved, true); assert.equal(c.readCases(storage, key)[0].title, 'Renamed'); assert.equal(c.removeCase(storage, key, saved.id).length, 0);
});
test('case bounds are UTF-8, count/total bounded, corrupt storage/quota failure do not silently erase', () => {
  const storage = memory(), key = c.caseScope(1, 1);
  for (let i = 0; i < 20; i++) c.storeCase(storage, key, record('c' + i), true);
  assert.throws(() => c.storeCase(storage, key, record('extra'), true), /20/); assert.equal(c.readCases(storage, key).length, 20);
  const big = record(); big.messages[0].content = 'я'.repeat(110000); assert.throws(() => c.cleanCase(big), /200 КБ/);
  storage.setItem('broken', 'not json'); assert.throws(() => c.storeCase(storage, 'broken', record(), true)); assert.equal(storage.getItem('broken'), 'not json');
  assert.throws(() => c.storeCase({ getItem: () => null, setItem: () => { throw Error('quota'); } }, key, record(), true), /quota/);
});
test('team SQL playbooks validate flags/duplicates/unknown fields; comparison opts into investigation', () => {
  assert.equal(c.playbooks.filter(item => /SQL|PostgreSQL/.test(item.label)).length, 3);
  assert.equal(c.customPrompts('[{"label":"Orders","prompt":"Check orders","comparePeriods":true}]')[0].investigation, true);
  for (const value of ['{}', '[{"label":"X","prompt":"p","write":true}]', '[{"label":"X","prompt":"p","needsPanel":"yes"}]', JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ label: 'x' + i, prompt: 'p' }))), JSON.stringify([{ label: c.playbooks[0].label, prompt: 'p' }])]) assert.throws(() => c.customPrompts(value));
});
