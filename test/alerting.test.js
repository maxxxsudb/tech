const test = require('node:test');
const assert = require('node:assert/strict');
const alerting = require('../plugin/alerting');
const now = Date.parse('2026-10-20T12:00:00Z');
const rule = { uid: 'r1', title: 'Postgres latency', condition: 'C', labels: { service: 'billing' }, annotations: { summary: 'Slow queries' }, data: [{ refId: 'A', datasourceUid: 'pg', relativeTimeRange: { from: 600, to: 0 }, model: { rawSql: 'SELECT $__time(time), value FROM measurements WHERE $__timeFilter(time)', format: 'time_series' } }] };
const instances = [{ fingerprint: 'one', generatorURL: 'http://grafana/grafana/alerting/grafana/r1/view', labels: { service: 'billing', severity: 'critical' }, startsAt: '2026-10-20T11:30:00Z', status: { state: 'active' } }, { fingerprint: 'two', labels: { __alert_rule_uid__: 'r2', service: 'billing', severity: 'critical' }, startsAt: '2026-10-20T11:00:00Z', status: { state: 'suppressed', silencedBy: ['silence'] } }];
const states = { status: 'success', data: { groups: [{ name: 'Postgres', interval: 60, rules: [{ name: rule.title, state: 'firing', health: 'ok', grafana_alert: { uid: rule.uid } }] }] } };
function reader(overrides = {}) {
  const requests = [];
  const request = async (path, options) => {
    requests.push({ path, options });
    const name = path.includes('/provisioning/') ? 'rules' : path.includes('/prometheus/') ? 'states' : 'instances';
    if (Object.hasOwn(overrides, name)) { const value = overrides[name]; if (value instanceof Error) throw value; return value; }
    return name === 'rules' ? path.endsWith('/r1') ? rule : [rule] : name === 'states' ? states : instances;
  };
  return { request, requests };
}

test('detects only Grafana managed rule pages, including subpaths', () => {
  assert.equal(alerting.ruleUid('/grafana/alerting/grafana/r1/view'), 'r1');
  assert.equal(alerting.ruleUid('/alerting/grafana/r%20a/edit'), 'r a');
  assert.equal(alerting.ruleUid('/alerting/list'), undefined);
  assert.equal(alerting.ruleUid('/alerting/new/grafana'), undefined);
});

test('rule triage reads only metadata and matches instances by UID, not alert name', async () => {
  const client = reader(); const signal = new AbortController().signal;
  const data = await alerting.readContext(client.request, { uid: 'r1', now, signal });
  assert.equal(client.requests.length, 3);
  assert.ok(client.requests.every(({ path, options }) => !path.includes('/api/ds/query') && !options.method && options.signal === signal));
  assert.equal(data.rule.data[0].model.rawSql, rule.data[0].model.rawSql);
  assert.equal(data.rule.state, 'firing'); assert.equal(data.totalInstances, 1); assert.equal(data.instances[0].fingerprint, 'one');
  assert.equal(data.timeRange.from, Date.parse('2026-10-20T11:00:00Z')); assert.equal(data.timeRange.to, now);
});

test('overview groups instances and suppression, not the number of rules', async () => {
  const { request } = reader(); const data = await alerting.readContext(request, { now });
  assert.equal(data.summary.instances, 2); assert.equal(data.summary.groups.length, 1);
  assert.equal(data.summary.groups[0].suppressed, 1); assert.equal(data.summary.groups[0].oldestAt, '2026-10-20T11:00:00Z');
  assert.deepEqual(data.summary.groups[0].ruleUids, ['r1', 'r2']); assert.equal(data.totalRules, 1);
});

test('403 remains unavailable while successful empty data is explicitly zero', async () => {
  const denied = Object.assign(new Error('Forbidden'), { status: 403 });
  const noAccess = await alerting.readContext(reader({ rules: denied, instances: denied }).request, { uid: 'r1', now });
  assert.equal(noAccess.summary, undefined); assert.equal(noAccess.totalInstances, undefined);
  assert.equal(noAccess.readStatus.instances.status, 403); assert.equal(noAccess.rule.uid, 'r1');
  const empty = await alerting.readContext(reader({ instances: [], rules: [] }).request, { now });
  assert.equal(empty.totalInstances, 0); assert.equal(empty.summary.instances, 0); assert.equal(empty.readStatus.instances.ok, true);
});

test('malformed API responses are errors and unassociated instances stay visible as uncertainty', async () => {
  const invalid = await alerting.readContext(reader({ instances: {}, states: { data: {} } }).request, { uid: 'r1', now });
  assert.equal(invalid.readStatus.instances.ok, false); assert.equal(invalid.readStatus.states.ok, false);
  const unknown = await alerting.readContext(reader({ instances: [{ ...instances[0], generatorURL: undefined, labels: { alertname: rule.title } }] }).request, { uid: 'r1', now });
  assert.equal(unknown.totalInstances, 0); assert.equal(unknown.unmatchedInstances, 1);
});

test('model lists are bounded, counts describe the full response and long incidents are clamped', async () => {
  const many = Array.from({ length: 70 }, (_, index) => ({ ...instances[0], fingerprint: String(index), startsAt: '2026-10-01T00:00:00Z' }));
  const data = await alerting.readContext(reader({ instances: many }).request, { uid: 'r1', now });
  assert.equal(data.instances.length, 50); assert.equal(data.totalInstances, 70); assert.equal(data.summary.instances, 70); assert.equal(data.truncated, true);
  assert.equal(data.timeRange.from, now - 24 * 3600000);
});

test('query panels retain PostgreSQL models and exclude expressions without guessing datasource', () => {
  const panels = alerting.rulePanels({ ...rule, data: [...rule.data, { refId: 'B', datasourceUid: '__expr__', model: { type: 'reduce' } }] }, () => ({ type: 'grafana-postgresql-datasource' }));
  assert.equal(panels.length, 1); assert.equal(panels[0].targets.length, 1);
  assert.equal(panels[0].targets[0].rawSql, rule.data[0].model.rawSql);
  assert.equal(panels[0].targets[0].datasource.type, 'grafana-postgresql-datasource');
  assert.deepEqual(alerting.linkedPanel({ annotations: { __dashboardUid__: 'dash', __panelId__: '7' } }), { dashboardUid: 'dash', panelId: 7 });
});

test('abort is propagated and never presented as an empty alert list', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(alerting.readContext(async () => { throw new DOMException('Aborted', 'AbortError'); }, { now, signal: controller.signal }), { name: 'AbortError' });
});

let factory;
global.define = (_, fn) => { factory = fn; }; delete require.cache[require.resolve('../plugin/module.js')]; require('../plugin/module.js'); delete global.define;
class AppPlugin { constructor() { const p = new Proxy(this, { get: () => () => p }); return p; } }
const runtime = { config: { appSubUrl: '/grafana', bootData: { user: { orgId: 1 } } }, getTemplateSrv: () => ({ getVariables: () => [{ name: 'old_dashboard', current: { value: 'must not leak' } }] }), getDataSourceSrv: () => ({ getInstanceSettings: () => ({ type: 'grafana-postgresql-datasource' }) }) };
const api = factory({ AppPlugin, BusEventWithPayload: class {} }, runtime, { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] }, {}, require('../plugin/attachments'), require('../plugin/conversation'), require('../plugin/query-tools'), {}, alerting);
const originalLocation = global.location, originalFetch = global.fetch;
test.after(() => { global.location = originalLocation; global.fetch = originalFetch; });
const flatten = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(flatten)] : [];

test('Alerting page without linked dashboard loads SQL rule context with no datasource request', async () => {
  global.location = { pathname: '/grafana/alerting/grafana/r1/view', search: '', href: 'http://localhost/grafana/alerting/grafana/r1/view' };
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(url.includes('/provisioning/') ? rule : url.includes('/prometheus/') ? states : instances)); };
  const context = await api.__features.loadContext();
  assert.equal(context.isAlerting, true); assert.equal(context.dashboardUid, undefined); assert.equal(context.alerting.rule.uid, 'r1');
  assert.deepEqual(context.variables, {}); assert.equal(context.panels[0].targets[0].rawSql, rule.data[0].model.rawSql);
  assert.ok(calls.every(call => call.options.method === 'GET' && call.url.startsWith('/grafana/api/') && !call.url.includes('/ds/query')));
  assert.match(api.__test.historyKey(context), /alert-r1/);
});

test('disabled Alerting does not call APIs', async () => {
  global.location = { pathname: '/grafana/alerting/list', search: '', href: 'http://localhost/grafana/alerting/list' };
  global.fetch = async () => { throw Error('must not request'); };
  const context = await api.__features.loadContext(undefined, { alertingEnabled: false });
  assert.equal(context.alertingDisabled, true); assert.equal(context.alerting, undefined);
});

test('alert card explains read failures, forbids unsafe runbook links, actions require clicks', async () => {
  const data = await alerting.readContext(reader({ instances: Object.assign(Error('Forbidden'), { status: 403 }), rules: { ...rule, annotations: { runbook_url: 'javascript:alert(1)' } } }).request, { uid: 'r1', now });
  let explain = 0;
  const tree = api.__features.AlertContextCard({ context: { alerting: data }, onExplain: () => explain++ });
  const nodes = flatten(tree); assert.equal(explain, 0);
  assert.ok(!nodes.some(node => node.type === 'a' && String(node.props.href).startsWith('javascript:')));
  assert.ok(nodes.some(node => node.children && node.children.includes('Число экземпляров не получено')));
  nodes.find(node => node.type === 'button' && node.children.includes('Разобрать алерт')).props.onClick(); assert.equal(explain, 1);
});
