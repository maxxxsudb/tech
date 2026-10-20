const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../plugin/query-tools');
const a = require('../plugin/alerting');
let factory;
global.define = (_, fn) => { factory = fn; };
delete require.cache[require.resolve('../plugin/module')]; require('../plugin/module'); delete global.define;
class AppPlugin { constructor() { const p = new Proxy(this, { get: () => () => p }); return p; } }
const pg = { uid: 'pg', type: 'grafana-postgresql-datasource' };
let saved = [], actual;
const runtime = { config: {}, getDataSourceSrv: () => ({ getInstanceSettings: () => pg }), getBackendSrv: () => ({ get: async () => ({ dashboard: { uid: 'd', panels: [actual] }, meta: { canSave: true } }), post: async (...args) => saved.push(args) }) };
const api = factory({ AppPlugin }, runtime, {}, {}, require('../plugin/attachments'), require('../plugin/conversation'), q, {}, a);
const source = { refId: 'B', datasource: pg, rawSql: 'SELECT 1', format: 'time_series', interval: '1m', custom: 'preserve' };
const panel = { id: 1, datasource: pg, targets: [source] }, context = { dashboardUid: 'd', panels: [panel] }, settings = api.__test.defaults;

test('parenthesized SQL syntax is accepted without allowing functions, writes or chaining', () => {
  for (const sql of ['SELECT a+b FROM t GROUP BY (a+b)', 'SELECT ts FROM t ORDER BY (ts)', 'SELECT row_number() OVER (PARTITION BY (id) ORDER BY ts) FROM t', 'SELECT CASE (status) WHEN 1 THEN 1 ELSE 0 END FROM t', "SELECT msg FROM t WHERE msg ILIKE ('%err%')", 'SELECT a FROM t WHERE a BETWEEN (1) AND (3)', "SELECT msg FROM t WHERE msg LIKE ('a%')"]) assert.doesNotThrow(() => q.boundedSql(sql), sql);
  for (const sql of ['SELECT foo(1)', 'SELECT pg_sleep(1)', 'SELECT 1; DELETE FROM t', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x']) assert.throws(() => q.boundedSql(sql), sql);
});
test('expression audit detects both variable spellings but preserves macros and named capture replacements', () => {
  const expr = 'label_replace(rate(up{job="$job"}[$__rate_interval]), "dst", "${capture}", "src", "(?P<capture>.*)") + up{env="${env}"}';
  assert.deepEqual(a.queryVariables({ expr }).expr, ['$job', '${env}']);
  assert.deepEqual(a.queryVariables({ expr: 'label_replace(sum by(job) (up), "dst", "$name", "src", "(?P<name>.*)")' }).expr, []);
  assert.deepEqual(a.queryVariables({ expr: 'up{literal="label_replace(abc) $job"}' }).expr, ['$job']);
  for (const expr of ['rate(up{job="$job"}[5m])', 'sum(rate({service="${service}"}[5m]))']) {
    const report = a.auditRules([{ uid: 'r', data: [{ refId: 'A', datasourceUid: 'ds', model: { expr } }] }], {});
    assert.ok(report.rules[0].issues.some(item => item.code === 'query_variables' && item.evidence.refId === 'A'));
  }
});
test('threshold boundaries, replay and unsupported operators are explicit', () => {
  for (const [operator, expected] of [['gt', [false,false,true]], ['gte', [false,true,true]], ['lt', [true,false,false]], ['lte', [true,true,false]]]) {
    assert.deepEqual([49,50,51].map(value => a.thresholdBreach(value,50,operator)), expected);
    const points = [49,50,51].map((value,i) => ({ at: i*60000, result: { status: 'ok', samples: [{ key: 'one', value, status: 'ok', labels: {} }] } }));
    assert.equal(a.replayStatistics(points,50,0,operator,60000).firingEpisodes,1);
    assert.equal(a.replayStatistics([points[1]],50,0,operator,60000).firingEpisodes, expected[1] ? 1 : 0);
  }
  assert.throws(() => a.thresholdBreach(1,1,'eq'));
});
test('folded diff retains all lines and edits when expanded', () => {
  const before = Array.from({length:40},(_,i)=>'line '+i).join('\n'), after = before.replace('line 20','changed');
  const lines = q.diffLines(before,after), folded = q.foldDiff(lines);
  assert.ok(folded.some(line=>line.type==='fold'));
  assert.deepEqual(folded.flatMap(line=>line.type==='fold'?line.lines:[line]),lines);
  assert.equal(folded.filter(line=>['add','remove'].includes(line.type)).length,2);
});
test('datetime fields round trip browser timezone to UTC and reject impossible local dates', () => {
  const before = process.env.TZ;
  try {
    process.env.TZ='Europe/Moscow';
    assert.equal(q.localDateTime('2026-10-20T12:34:56Z'),'2026-10-20T15:34:56');
    assert.equal(q.localDateTimeIso('2026-10-20T15:34:56'),'2026-10-20T12:34:56.000Z');
    assert.equal(q.localDateTimeIso('2026-02-30T12:00'),'');
    assert.equal(q.localDateTimeIso(''),'');
    process.env.TZ='America/New_York';
    assert.equal(q.localDateTimeIso('2026-03-08T02:30'),'');
  } finally { if(before===undefined) delete process.env.TZ; else process.env.TZ=before; }
});
test('code proposal preserves query model and refuses ambiguous or incompatible context', () => {
  const p=api.__features.codeProposal(context,[1],'sql','SELECT 2',settings);
  assert.deepEqual(p.targets[0],{...source, rawSql:'SELECT 2',rawQuery:true,editorMode:'code'});
  assert.equal(source.rawSql,'SELECT 1');
  for(const [c,ids,lang] of [[context,[1,2],'sql'],[context,[1],'promql'],[{...context,isAlerting:true},[1],'sql'],[{...context,panels:[{...panel,targets:[source,{...source,refId:'C'}]}]},[1],'sql']]) assert.equal(api.__features.codeProposal(c,ids,lang,'SELECT 2',settings),undefined);
});
test('apply compares the displayed original targets against current server query before any save', async () => {
  actual={...panel,targets:[{...source,rawSql:'SELECT 3'}]}; saved=[];
  const proposal={panelId:1,expectedTargets:[source],targets:[{...source,rawSql:'SELECT 2'}]};
  await assert.rejects(api.__features.applyDashboardProposal(settings,context,proposal),/изменились/); assert.equal(saved.length,0);
  actual=structuredClone(panel);
  await api.__features.applyDashboardProposal(settings,context,proposal); assert.equal(saved.length,1); assert.equal(saved[0][1].overwrite,false);
  const other={...source,refId:'C',rawSql:'SELECT 7'};
  actual={...panel,targets:[source,{...other,rawSql:'SELECT 8'}]};saved=[];
  await api.__features.applyDashboardProposal(settings,context,{...proposal,expectedTargets:[source,other],selectedTargets:{targets:proposal.targets,ids:['B']}});
  assert.equal(saved[0][1].dashboard.panels[0].targets[1].rawSql,'SELECT 8');
});
