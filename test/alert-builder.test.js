const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../plugin/alerting');
const q = require('../plugin/query-tools');
const draft = { uid: 'ai-fixture', title: 'SQL rule', folderUID: 'folder', ruleGroup: 'group', source: { datasource: { uid: 'pg', type: 'grafana-postgresql-datasource' }, rawSql: 'SELECT $__timeTo()::timestamptz AS time, max(value) AS value FROM samples WHERE $__timeFilter(time)' }, reducer: 'max', operator: 'gt', threshold: 50, for: '2m', intervalSeconds: 60, lookbackSeconds: 300, labels: { service: 'api' }, annotations: { summary: 'Fixture' } };
const rule = () => a.buildRule(draft, q.boundedSql);
function response(value, labels = {}) {
  const frame = (refId, number) => ({ schema: { fields: [{ name: refId, type: 'number', labels }] }, data: { values: [[number]] } });
  return { results: { A: {}, B: { frames: [frame('B', value)] }, C: { frames: [frame('C', value > 50 ? 1 : 0)] } } };
}
function points(values) { return values.map((value, i) => ({ at: 1000000 + i * 60000, result: value === null ? { status: 'noData' } : a.evaluateFrames(response(value)) })); }

test('builder emits deterministic paused A/reduce/threshold with inherited source and no arbitrary JSON', () => {
  const r = rule(); assert.equal(r.isPaused, true); assert.equal(r.condition, 'C'); assert.equal(r.noDataState, 'NoData'); assert.equal(r.execErrState, 'Error');
  assert.equal(r.data[0].model.rawSql, draft.source.rawSql); assert.equal(r.data[0].model.format, 'time_series');
  assert.equal(r.data[0].relativeTimeRange.from, 300); assert.equal(r.data[1].model.expression, 'A'); assert.equal(r.data[2].model.conditions[0].evaluator.params[0], 50);
  assert.equal(a.canonical(r), a.canonical(rule()));
  assert.ok(!('orgID' in r)); assert.ok(!('provenance' in r));
});
test('builder rejects missing threshold, invalid sources, unresolved variables, writes and managed/active input', () => {
  for (const patch of [{ threshold: '' }, { threshold: Infinity }, { isPaused: false }, { provenance: 'file' }, { for: 'nonsense' }, { lookbackSeconds: 0 }, { reducer: 'math' }, { source: { ...draft.source, rawSql: 'DELETE FROM samples' } }, { source: { ...draft.source, rawSql: 'SELECT value FROM $table' } }]) assert.throws(() => a.buildRule({ ...draft, ...patch }, q.boundedSql));
});
test('evaluation matches reduce/condition label sets and distinguishes error, noData and unsupported shape', () => {
  assert.equal(a.evaluateFrames(response(100)).samples[0].condition, true);
  assert.equal(a.evaluateFrames({ results: { A: { error: 'bad SQL' } } }).status, 'error');
  assert.equal(a.evaluateFrames({ results: { B: { frames: [] } } }).status, 'noData');
  const multi = response(100); multi.results.B.frames[0].data.values[0].push(1); assert.equal(a.evaluateFrames(multi).status, 'unsupported');
  const duplicate = response(100); duplicate.results.B.frames.push(duplicate.results.B.frames[0]); assert.equal(a.evaluateFrames(duplicate).status, 'unsupported');
});
test('replay plan preserves actual group step and rejects non-historical SQL and excessive load', () => {
  const to = Date.now() - 1000, from = to - 20 * 60000;
  const p = a.planReplay(rule(), 60, from, to); assert.equal(p.stepMs, 60000); assert.equal(p.evaluations, 20);
  assert.throws(() => a.planReplay(rule(), 60, to - 7 * 86400000, to), /лимит 500/);
  assert.throws(() => a.planReplay({ ...rule(), data: [] }, 60, from, to), /builder/);
  const nowRule = rule(); nowRule.data[0].model.rawSql += ' AND time < now()'; assert.throws(() => a.planReplay(nowRule, 60, from, to), /текущее время/);
  const fixed = rule(); fixed.data[0].model.rawSql = 'SELECT value FROM samples'; assert.throws(() => a.planReplay(fixed, 60, from, to), /движущегося окна/);
});
test('step/spike timeline honors pending duration, episode closure and unknown gaps', () => {
  const result = a.replayStatistics(points([0, 100, 100, 100, 100, 0, 100, 0]), 50, 120, 'gt', 60000);
  assert.equal(result.firingEpisodes, 1); assert.equal(result.episodes[0].start, 1180000); assert.equal(result.episodes[0].end, 1300000); assert.equal(result.longestObservedMs, 120000);
  const gap = a.replayStatistics(points([0, 100, 100, null, 100, 100, 0]), 50, 120, 'gt', 60000); assert.equal(gap.firingEpisodes, 0); assert.ok(gap.unknownInstanceEvaluations > 0);
  const boundary = a.replayStatistics(points([100, 100, null]), 50, 0, 'gt', 60000); assert.equal(boundary.episodes[0].leftCensored, true); assert.equal(boundary.episodes[0].rightCensored, true); assert.equal(boundary.longestObservedMs, 60000);
});
test('replay executes rolling backend eval at every instant; sweep uses those same values without extra SQL', async () => {
  const r = rule(), to = Math.floor((Date.now() - 60000) / 60000) * 60000, plan = a.planReplay(r, 60, to - 5 * 60000, to);
  const calls = [];
  const replay = await a.replayRule(async (path, options) => { calls.push({ path, options }); return response(calls.length === 2 ? 100 : 0); }, r, plan, { thresholds: [50, 150], pending: [0, 120] });
  assert.equal(calls.length, 6); assert.equal(replay.variants.length, 4); assert.equal(replay.coverage, 1);
  assert.deepEqual(calls.map(call => Date.parse(call.options.body.now)), Array.from({ length: 6 }, (_, i) => plan.from + i * 60000));
  assert.ok(calls.every(call => call.path === '/api/v1/eval' && call.options.body.data[0].relativeTimeRange.from === 300));
  assert.equal(replay.variants[0].statistics.firingEpisodes, 1); assert.equal(replay.variants[1].statistics.firingEpisodes, 0);
  await assert.rejects(a.replayRule(async () => response(0), { ...r, title: 'changed' }, plan), /изменён/);
});
test('403/abort stop replay immediately and per-step SQL errors remain incomplete coverage', async () => {
  const r = rule(), to = Date.now() - 60000, p = a.planReplay(r, 60, to - 3 * 60000, to); let calls = 0;
  await assert.rejects(a.replayRule(async () => { calls++; throw Object.assign(Error('Forbidden'), { status: 403 }); }, r, p), { status: 403 }); assert.equal(calls, 1);
  const result = await a.replayRule(async () => ({ results: { A: { error: 'SQL error' } } }), r, p); assert.equal(result.errors, p.evaluations); assert.equal(result.coverage, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(a.replayRule(async () => response(0), r, p, { signal: controller.signal }), { name: 'AbortError' });
});
function checks(r) { return { groupCount: 1, preview: { status: 'ok', at: Date.now(), fingerprint: a.canonical(r) }, replay: { complete: true, checkedAt: Date.now(), fingerprint: a.canonical(r), errors: 0, noData: 0, coverage: 1, plan: { intervalSeconds: 60 } } }; }
test('create requires fresh exact evidence, confirmation, role and matching group; never updates or enables', async () => {
  const r = rule(), calls = [];
  const request = async (path, options = {}) => { calls.push({ path, options }); if (path.endsWith('/ai-fixture')) throw { status: 404 }; if (path.includes('/rule-groups/')) return { interval: 60, rules: [{}] }; return r; };
  for (const options of [{ role: 'Viewer', confirmed: true }, { role: 'Admin', confirmed: false }]) await assert.rejects(a.createPaused(request, r, checks(r), options));
  const stale = checks(r); stale.preview.at = 0; await assert.rejects(a.createPaused(request, r, stale, { role: 'Admin', confirmed: true })); assert.equal(calls.length, 0);
  const partial = checks(r); partial.replay.coverage = 0.5; partial.replay.noData = 1; await assert.rejects(a.createPaused(request, r, partial, { role: 'Admin', confirmed: true })); assert.equal(calls.length, 0);
  const result = await a.createPaused(request, r, checks(r), { role: 'Admin', confirmed: true }); assert.equal(result.rule.isPaused, true);
  assert.deepEqual(calls.filter(call => call.options.method).map(call => call.options.method), ['POST']);
  assert.equal(calls.at(-1).options.body.isPaused, true);
});
test('matching existing UID is idempotent; occupied or active UID cannot be overwritten', async () => {
  const r = rule(); let calls = 0;
  const result = await a.createPaused(async () => { calls++; return { ...r, provenance: 'api' }; }, r, checks(r), { confirmed: true, role: 'Admin' });
  assert.equal(result.alreadyCreated, true); assert.equal(calls, 1);
  await assert.rejects(a.createPaused(async () => ({ ...r, isPaused: false }), r, checks(r), { confirmed: true, role: 'Admin' }), /перезапись запрещена/);
});
test('changed group interval or membership blocks creation without any POST', async () => {
  const r = rule();
  for (const group of [{ interval: 30, rules: [{}] }, { interval: 60, rules: [{}, {}] }]) {
    let writes = 0;
    await assert.rejects(a.createPaused(async (path, options = {}) => { if (options.method) writes++; if (path.endsWith('/ai-fixture')) throw { status: 404 }; return group; }, r, checks(r), { confirmed: true, role: 'Admin' }));
    assert.equal(writes, 0);
  }
});
test('templates quote identifiers and retain SQL time macros; audit storage failure is explicit', () => {
  for (const kind of ['count', 'mean', 'error_ratio']) {
    const sql = a.postgresTemplate(kind, { schema: 'public', table: 'Orders"Name', timeColumn: 'time', valueColumn: 'value' });
    assert.match(sql, /"Orders""Name"/); assert.match(sql, /\$__timeFilter/); assert.doesNotThrow(() => q.boundedSql(sql));
  }
  assert.equal(a.appendCreationAudit({ getItem: () => '[]', setItem() { throw Error('Quota'); } }, 'k', {}).ok, false);
});
