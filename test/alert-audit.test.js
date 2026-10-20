const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../plugin/alerting');
const now = Date.parse('2026-10-20T12:00:00Z');
const rule = { uid: 'sql', title: 'SQL rule', for: '5m', interval: 60, condition: 'C', noDataState: 'NoData', execErrState: 'Error', labels: { team: 'platform', service: 'api', severity: 'critical' }, annotations: { summary: 'Latency', description: 'Investigate DB', runbook_url: 'https://example.com/runbook', __dashboardUid__: 'dashboard', __panelId__: '1' }, data: [{ refId: 'A', datasourceUid: 'pg', relativeTimeRange: { from: 600, to: 0 }, model: { rawSql: 'SELECT value FROM orders WHERE $__timeFilter(created_at)' } }] };
const contacts = [{ name: 'default' }, { name: 'api' }, { name: 'critical' }];
const resources = { policies: { receiver: 'default' }, contacts, timings: [], folders: [] };
test('healthy checklist has score 100; issues carry evidence; paused/provisioned are informational', () => {
  const result = a.auditRules([{ ...rule, isPaused: true, provenance: 'file' }], resources, now).rules[0];
  assert.equal(result.score, 100); assert.ok(result.issues.some(i => i.code === 'paused')); assert.ok(result.issues.every(i => i.evidence));
  assert.equal(result.routing.routes[0].receiver, 'default'); assert.equal(result.routing.deliveryVerified, false);
});
test('audit finds masked errors, missing metadata, short windows, SQL variables and duplicates deterministically', () => {
  const bad = { ...rule, uid: 'bad', for: '0s', noDataState: 'OK', execErrState: 'Normal', labels: {}, annotations: {}, data: [{ ...rule.data[0], relativeTimeRange: { from: 30, to: 0 }, model: { rawSql: 'SELECT value FROM $table WHERE $__timeFilter(time)' } }] };
  const report = a.auditRules([bad, { ...bad, uid: 'copy' }], resources, now);
  const issues = report.rules[0].issues;
  for (const code of ['pending', 'noDataState', 'execErrState', 'annotation_runbook_url', 'label_team', 'panel_link', 'query_range', 'sql_variables', 'duplicate']) assert.ok(issues.some(i => i.code === code), code);
  assert.deepEqual(issues.find(i => i.code === 'duplicate').evidence.otherRuleUids, ['copy']);
  assert.ok(report.rules[0].score < 100); assert.ok(issues.every(i => i.evidence));
});
test('nested routes inherit receiver, honor continue, fallback and negative/missing labels', () => {
  const policy = { receiver: 'default', routes: [{ object_matchers: [['service', '=', 'api']], continue: true, routes: [{ object_matchers: [['severity', '=~', 'critical|warning']], receiver: 'critical' }] }, { object_matchers: [['missing', '!=', 'x']], receiver: 'api' }] };
  const result = a.routePreview(policy, rule.labels, contacts, [], now);
  assert.equal(result.status, 'known'); assert.deepEqual(result.routes.map(r => r.receiver), ['critical', 'api']);
  policy.routes[0].continue = false;
  assert.deepEqual(a.routePreview(policy, rule.labels, contacts, [], now).routes.map(r => r.receiver), ['critical']);
  assert.equal(a.routePreview({ receiver: 'default', routes: [{ object_matchers: [['service', '=', 'db']], receiver: 'api' }] }, rule.labels, contacts, [], now).routes[0].path, 'root');
  assert.equal(a.routePreview({ receiver: 'default', routes: [{ matchers: ['service="api"', 'severity=~"critical|warning"'], receiver: 'api' }] }, rule.labels, contacts, [], now).routes[0].receiver, 'api');
});
test('complex regex, missing folder label, unavailable policies/contacts never become a verified route', () => {
  const policy = { receiver: 'default', routes: [{ object_matchers: [['service', '=~', '(api|worker)+']], receiver: 'api' }] };
  assert.equal(a.routePreview(policy, rule.labels, contacts, [], now).status, 'partial');
  assert.equal(a.routePreview({ ...policy, routes: [{ object_matchers: [['grafana_folder', '=', 'Ops']], receiver: 'api' }] }, rule.labels, contacts, [], now, ['grafana_folder']).status, 'partial');
  assert.equal(a.routePreview(undefined, rule.labels, contacts, [], now).status, 'unavailable');
  assert.equal(a.routePreview(resources.policies, rule.labels, undefined, [], now).status, 'partial');
  const dynamic = a.auditRules([rule], { ...resources, policies: { receiver: 'default', routes: [{ object_matchers: [['instance', '=', 'prod']], receiver: 'api' }] } }, now);
  assert.equal(dynamic.rules[0].routing.status, 'partial');
  const templated = a.auditRules([{ ...rule, labels: { ...rule.labels, service: '{{ $labels.service }}' } }], { ...resources, policies: { receiver: 'default', routes: [{ object_matchers: [['service', '=', 'api']], receiver: 'api' }] } }, now);
  assert.equal(templated.rules[0].routing.status, 'partial');
});
test('mute timing honors timezone, inclusive calendar/exclusive end, last month day and active windows', () => {
  const timing = { name: 'office', time_intervals: [{ location: 'Europe/Moscow', times: [{ start_time: '15:00', end_time: '16:00' }], weekdays: ['monday:friday'], months: ['october'], years: ['2026'], days_of_month: ['20:21'] }] };
  assert.equal(a.timingActive(timing, now), true); assert.equal(a.timingActive(timing, now + 3600000), false);
  assert.equal(a.timingActive({ time_intervals: [{ days_of_month: ['-1'] }] }, Date.parse('2026-02-28T12:00:00Z')), true);
  assert.equal(a.timingActive({ time_intervals: [{ months: ['10:12'] }] }, now), true);
  assert.equal(a.timingActive({ time_intervals: [{ location: 'Bad/Timezone' }] }, now), undefined);
  const preview = a.routePreview({ receiver: 'default', mute_time_intervals: ['office'] }, {}, contacts, [timing], now);
  assert.equal(preview.routes[0].muted, true);
  assert.equal(a.routePreview({ receiver: 'default', mute_time_intervals: ['missing'] }, {}, contacts, [], now).routes[0].muted, undefined);
});
test('audit reads only GET APIs, strips contact settings, exports evidence and retains 403 limitations', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/alert-rules')) return [rule];
    if (path.includes('/prometheus/')) return { status: 'success', data: { groups: [{ name: 'g', interval: 60, rules: [{ grafana_alert: { uid: rule.uid } }] }] } };
    if (path.endsWith('/policies')) return resources.policies;
    if (path.endsWith('/contact-points')) return [{ name: 'default', type: 'email', settings: { addresses: 'private@example.com' }, secureFields: { secret: true } }];
    if (path.endsWith('/mute-timings')) throw Object.assign(Error('Forbidden'), { status: 403 });
    return [];
  };
  const report = await a.readAudit(request, { now });
  assert.equal(report.totalRules, 1); assert.equal(report.readStatus.timings.status, 403); assert.ok(calls.every(c => !c.options.method));
  assert.ok(!JSON.stringify(report).includes('private@example.com'));
  const md = a.auditMarkdown(report); assert.match(md, /SQL rule/); assert.match(md, /доставк|Доставк/); assert.match(md, /Нет права чтения/);
  const denied = await a.readAudit(async () => { throw Object.assign(Error('Forbidden'), { status: 403 }); });
  assert.equal(denied.unavailable, true); assert.equal(denied.totalRules, undefined);
});
