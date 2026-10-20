const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../plugin/alerting');
const q = require('../plugin/query-tools');
const clone = value => structuredClone(value);
const draft = { uid: 'fixture', title: 'SQL', folderUID: 'f', ruleGroup: 'g', intervalSeconds: 60, lookbackSeconds: 300, for: '2m', threshold: 50, operator: 'gt', reducer: 'max', source: { datasource: { uid: 'pg', type: 'grafana-postgresql-datasource' }, rawSql: 'SELECT $__timeTo()::timestamptz AS time, max(value) AS value FROM samples WHERE $__timeFilter(time)' } };
function snapshot() {
  const rule = a.buildRule(draft, q.boundedSql);
  return { rule, provenance: '', resource: { kind: 'AlertRule', apiVersion: 'rules.alerting.grafana.app/v0alpha1', metadata: { name: rule.uid, namespace: 'default', uid: 'identity', resourceVersion: '2', annotations: { 'grafana.app/folder': 'f', 'grafana.com/provenance': '' } }, spec: { title: rule.title, paused: true, for: rule.for, trigger: { interval: '1m' }, noDataState: rule.noDataState, execErrState: rule.execErrState, expressions: Object.fromEntries(rule.data.map(query => [query.refId, { source: query.refId === 'C', datasourceUID: query.datasourceUid, model: query.model, relativeTimeRange: { from: query.relativeTimeRange.from + 's', to: '0s' } }])) } } };
}
function server(initial) {
  let current = clone(initial), removed = false; const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options: clone({ ...options, signal: undefined }) });
    if (removed) throw { status: 404 };
    if (!options.method) return clone(path.startsWith('/apis') ? current.resource : current.rule);
    if (options.method === 'PATCH') { assert.equal(options.contentType, 'application/json-patch+json'); for (const op of options.body.filter(op => op.op === 'test')) assert.deepEqual(op.value, op.path === '/spec' ? current.resource.spec : current.resource.metadata[op.path.split('/').at(-1)]); current.resource.spec = clone(options.body.at(-1).value); current.resource.metadata.resourceVersion = '3'; current.rule = a.resourceRule(current.resource); return clone(current.resource); }
    if (options.method === 'DELETE') { removed = true; return {}; }
    throw Error('unexpected');
  };
  return { request, calls, change: patch => Object.assign(current, patch) };
}
test('resource conversion retains condition, query duration, provenance and identity', async () => {
  const s = snapshot(), r = a.resourceRule(s.resource); assert.equal(r.condition, 'C'); assert.equal(r.data[0].relativeTimeRange.from, 300);
  const api = server(s), result = await a.readManagedRule(api.request, 'default', 'fixture'); assert.equal(result.provenance, '');
  await assert.rejects(a.readManagedRule(api.request, 'wrong-namespace', 'fixture'), /идентичность/);
  assert.throws(() => a.ruleResourcePath('', 'fixture'), /namespace/);
});
test('update/rollback force pause; PATCH tests identity, version and full spec; journal round trip', async () => {
  const s = snapshot(); s.resource.spec.paused = false;
  const plan = a.lifecyclePlan(s, 'update', { title: 'new', for: '3m', threshold: 80 }); assert.equal(plan.after.spec.paused, true);
  assert.equal(plan.after.spec.expressions.C.model.conditions[0].evaluator.params[0], 80); assert.equal(s.resource.spec.title, 'SQL');
  const api = server(s), result = await a.applyLifecycle(api.request, 'default', plan, { confirmed: true, role: 'Admin' });
  assert.equal(result.resource.spec.title, 'new'); assert.deepEqual(api.calls.filter(c => c.options.method).map(c => c.options.method), ['PATCH']);
  const undo = a.lifecyclePlan(result, 'rollback', { before: s.resource, after: result.resource }); assert.equal(undo.after.spec.title, 'SQL'); assert.equal(undo.after.spec.paused, true);
  result.resource.spec.title = 'somebody else'; assert.throws(() => a.lifecyclePlan(result, 'rollback', { before: s.resource, after: plan.after }), /изменилось/);
});
test('no mutation on role/confirmation/stale-plan/provenance/version failure; provisioned api is blocked', async () => {
  for (const patch of [{ provenance: 'api' }, { provenance: 'file' }]) { const s = { ...snapshot(), ...patch }, api = server(s); await assert.rejects(a.applyLifecycle(api.request, 'default', a.lifecyclePlan(s, 'pause'), { confirmed: true, role: 'Admin' }), /Provisioned/); assert.equal(api.calls.length, 0); }
  const s = snapshot(), p = a.lifecyclePlan(s, 'pause'), api = server(s);
  for (const options of [{ confirmed: false, role: 'Admin' }, { confirmed: true, role: 'Viewer' }]) await assert.rejects(a.applyLifecycle(api.request, 'default', p, options));
  await assert.rejects(a.applyLifecycle(api.request, 'default', { ...p, at: 0 }, { confirmed: true, role: 'Admin' }), /устарел/);
  const changed = clone(s.resource); changed.metadata.resourceVersion = '9'; api.change({ resource: changed });
  await assert.rejects(a.applyLifecycle(api.request, 'default', p, { confirmed: true, role: 'Admin' }), /изменилось/); assert.equal(api.calls.filter(c => c.options.method).length, 0);
});
test('enable requires exact fresh proof and delivery acknowledgement; delete requires UID and race acknowledgement', async () => {
  const s = snapshot(), p = a.lifecyclePlan(s, 'enable'), api = server(s), base = { confirmed: true, role: 'Admin' };
  await assert.rejects(a.applyLifecycle(api.request, 'default', p, base), /eval/);
  await a.applyLifecycle(api.request, 'default', p, { ...base, acceptEnable: true, preview: { status: 'ok', at: Date.now(), fingerprint: a.canonical(s.resource.spec) } });
  const api2 = server(s), deletion = a.lifecyclePlan(s, 'delete');
  await assert.rejects(a.applyLifecycle(api2.request, 'default', deletion, { ...base, typedUid: 'wrong', acceptDeleteRace: true }), /UID/);
  const result = await a.applyLifecycle(api2.request, 'default', deletion, { ...base, typedUid: 'fixture', acceptDeleteRace: true }); assert.equal(result.deleted, true);
  assert.equal(api2.calls.find(c => c.options.method === 'DELETE').options.body.preconditions.uid, 'identity');
});
test('Grafana JSON import round trip creates new UID and reselects placement, refuses lossy variants and SQL writes', () => {
  const r = a.buildRule(draft, q.boundedSql), imported = a.importDraft(JSON.stringify({ rule: r, groupIntervalSeconds: 60 }), 'new', q.boundedSql);
  assert.equal(imported.uid, 'new'); assert.equal(imported.folderUID, ''); assert.equal(imported.ruleGroup, ''); assert.equal(imported.threshold, 50); assert.equal(imported.source.rawSql, draft.source.rawSql);
  const resource = snapshot().resource; assert.equal(a.importDraft(JSON.stringify(resource), 'new', q.boundedSql).title, r.title);
  for (const mutate of [x => x.data[0].model.rawSql = 'DELETE FROM t', x => x.notificationSettings = { receiver: 'x' }, x => x.noDataState = 'OK', x => x.data[1].model.settings = { mode: 'dropNN' }, x => x.data[0].model.extra = 'lost']) { const bad = clone(r); mutate(bad); assert.throws(() => a.importDraft(JSON.stringify(bad), 'new', q.boundedSql)); }
  assert.throws(() => a.importDraft(' '.repeat(500001), 'new', q.boundedSql), /500/);
});
test('GitOps patch/YAML export are pure, include expected version and preserve strings safely', () => {
  const p = a.lifecyclePlan(snapshot(), 'update', { title: 'line\nquoted: "x"', for: '5m' });
  const patch = a.lifecyclePatch(p); assert.equal(patch[1].value, '2'); assert.equal(patch[2].op, 'test'); assert.equal(patch[3].value.paused, true);
  const text = a.yaml({ patch, key: ': value\nnext', list: [] }); assert.match(text, /\\n/); assert.match(text, /"list": \[\]/);
});
const fields = () => ({ matchers: [{ name: 'service', value: 'fixture', isRegex: false, isEqual: true }], startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), comment: 'maintenance', createdBy: 'test' });
test('silence rejects empty/global/regex/negative matchers, absent comment and excessive duration', () => {
  for (const patch of [{ matchers: [] }, { matchers: [{ name: 'x', value: '' }] }, { matchers: [{ name: 'x', value: '.*', isRegex: true }] }, { matchers: [{ name: 'x', value: 'y', isEqual: false }] }, { comment: '' }, { endsAt: new Date(Date.now() + 8 * 86400000).toISOString() }]) assert.throws(() => a.silenceBody({ ...fields(), ...patch }));
});
test('silence preview matches all exact labels; changed blast radius prevents POST; create/expire verify readback', async () => {
  let alerts = [{ fingerprint: 'one', labels: { service: 'fixture' } }, { fingerprint: 'two', labels: { service: 'other' } }], saved, methods = [];
  const request = async (path, options = {}) => { if (options.method) methods.push(options.method); if (path.endsWith('/alerts')) return clone(alerts); if (options.method === 'POST') { saved = { ...options.body, id: 'silence-id', status: { state: 'active' } }; return { silenceID: saved.id }; } if (options.method === 'DELETE') { saved.status.state = 'expired'; return {}; } return saved ? [clone(saved)] : []; };
  const preview = await a.previewSilence(request, fields()); assert.equal(preview.affected.length, 1); assert.deepEqual(methods, []);
  alerts.push({ fingerprint: 'three', labels: { service: 'fixture' } }); await assert.rejects(a.applySilence(request, preview, { confirmed: true, role: 'Admin' }), /Состав/); assert.deepEqual(methods, []);
  const fresh = await a.previewSilence(request, fields()), result = await a.applySilence(request, fresh, { confirmed: true, role: 'Admin' }); assert.equal(result.id, 'silence-id');
  await assert.rejects(a.expireSilence(request, result, { confirmed: true, role: 'Admin', typedId: 'wrong' }), /ID/);
  await a.expireSilence(request, result, { confirmed: true, role: 'Admin', typedId: result.id }); assert.deepEqual(methods, ['POST', 'DELETE']);
});
test('silence edits detect concurrent modification and no retry occurs after uncertain write', async () => {
  const f = { ...fields(), id: 'existing' }, before = { ...f, status: { state: 'active' } }; let posts = 0;
  const request = async (path, options = {}) => { if (options.method) { posts++; throw { status: 403 }; } return path.endsWith('/alerts') ? [] : [{ ...before, comment: 'changed' }]; };
  const p = await a.previewSilence(request, f); await assert.rejects(a.applySilence(request, p, { role: 'Admin', confirmed: true, before }), /изменился/); assert.equal(posts, 0);
  const p2 = await a.previewSilence(request, fields()); await assert.rejects(a.applySilence(request, p2, { role: 'Admin', confirmed: true }), { status: 403 }); assert.equal(posts, 1);
});
