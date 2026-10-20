const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../plugin/query-tools');
const a = require('../plugin/alerting');
let factory;
global.define = (_, fn) => { factory = fn; };
delete require.cache[require.resolve('../plugin/module')]; require('../plugin/module'); delete global.define;
class AppPlugin { constructor() { const p = new Proxy(this, { get: () => () => p }); return p; } }
const pg = { uid: 'pg', type: 'grafana-postgresql-datasource' };
let saved = [], actual, reads = 0;
const runtime = { config: {}, getDataSourceSrv: () => ({ getInstanceSettings: () => pg }), getBackendSrv: () => ({ get: async () => { reads++; return { dashboard: { uid: 'd', panels: [actual] }, meta: { canSave: true } }; }, post: async (...args) => saved.push(args) }) };
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
test('SQL proposal rejects writes and unreviewed calls before any datasource fetch or dashboard GET/POST', async () => {
  const originalFetch=global.fetch;let fetches=0;
  global.fetch=async()=>{fetches++;throw Error('Unexpected network');};
  try {
    for(const rawSql of ['DELETE FROM users','UPDATE users SET active=false','WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x','SELECT 1; DROP TABLE users','SELECT nextval(\'seq\')','SELECT pg_sleep(1)','SELECT custom_function(1)']) for(const datasource of [undefined,pg,'pg',{uid:'pg',type:'prometheus'}]) {
      reads=0;saved=[];actual=structuredClone(panel);
      const target={refId:'B',rawSql,...(datasource?{datasource}:{})}, proposal={panelId:1,targets:[target]};
      await assert.rejects(api.__features.validateDashboardProposal(settings,context,proposal));
      await assert.rejects(api.__features.applyDashboardProposal(settings,context,proposal));
      assert.equal(fetches,0);assert.equal(reads,0);assert.equal(saved.length,0);
      assert.equal(api.__test.exploreUrl(context,pg,target),undefined);
    }
    assert.equal(api.__test.exploreUrl(context,pg,{rawSql:'SELECT * FROM ${table:raw}'}),undefined);
  } finally {global.fetch=originalFetch;}
});
test('SQL proposal rechecks interpolated variables before query and save', async()=>{
  const original=runtime.getDataSourceSrv,oldFetch=global.fetch;let fetches=0;reads=0;saved=[];
  runtime.getDataSourceSrv=()=>({getInstanceSettings:()=>pg,get:async()=>({getRef:()=>pg,interpolateVariablesInQueries:queries=>queries.map(query=>({...query,rawSql:query.rawSql.replace('$table','orders; DELETE FROM users')}))})});
  global.fetch=async()=>{fetches++;throw Error('Unexpected query');};
  try {
    const proposal={panelId:1,targets:[{...source,rawSql:'SELECT * FROM $table'}]};
    await assert.rejects(api.__features.validateDashboardProposal(settings,context,proposal));
    await assert.rejects(api.__features.applyDashboardProposal(settings,context,proposal));
    assert.equal(fetches,0);assert.equal(reads,0);assert.equal(saved.length,0);
  } finally {runtime.getDataSourceSrv=original;global.fetch=oldFetch;}
});
test('preview executes bounded raw SQL with original format; apply retains full original SQL', async()=>{
  const originalFetch=global.fetch;let body;
  global.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({results:{B:{frames:[]}}}));};
  try {
    const proposal={panelId:1,targets:[{...source,rawSql:'SELECT 2',rawQuery:false}]};
    await api.__features.validateDashboardProposal(settings,context,proposal);
    assert.match(body.queries[0].rawSql,/LIMIT 101$/);assert.equal(body.queries[0].format,'time_series');assert.equal(body.queries[0].rawQuery,true);
    saved=[];actual=structuredClone(panel);await api.__features.applyDashboardProposal(settings,context,proposal);
    assert.equal(saved[0][1].dashboard.panels[0].targets[0].rawSql,'SELECT 2');
  } finally {global.fetch=originalFetch;}
});
test('legacy string datasource resolves for code proposals and SELECT preview/apply while writes stay blocked',async()=>{
  const oldFetch=global.fetch,oldSrv=runtime.getDataSourceSrv;let bodies=[];
  runtime.getDataSourceSrv=()=>({getInstanceSettings:uid=>uid==='pg'?{...pg,secret:'not query metadata'}:undefined});
  global.fetch=async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({results:{B:{frames:[]}}}));};
  try {
    for(const [datasource,targetDatasource] of [['pg','pg'],['pg',undefined],[pg,'pg'],[{uid:'pg'},{uid:'pg'}]]) {
      const legacy={...panel,datasource,targets:[{...source,datasource:targetDatasource}]},ctx={...context,panels:[legacy]};
      const candidates=api.__features.codeProposalCandidates(ctx,[1],'sql','SELECT 2',settings);
      assert.equal(candidates.length,1);
      const proposal=api.__features.codeProposal(ctx,[1],'sql','SELECT 2',settings);
      assert.equal((await api.__features.validateDashboardProposal(settings,ctx,proposal)).ok,true);
      assert.deepEqual(bodies.at(-1).queries[0].datasource,pg);
      assert.match(bodies.at(-1).queries[0].rawSql,/LIMIT 101$/);
      actual=structuredClone(legacy);saved=[];await api.__features.applyDashboardProposal(settings,ctx,proposal);
      assert.equal(saved.length,1);assert.equal(saved[0][1].dashboard.panels[0].targets[0].rawSql,'SELECT 2');
      const count=bodies.length;reads=0;saved=[];
      const unsafe={panelId:1,targets:[{refId:'B',rawSql:'DELETE FROM orders'}]};
      await assert.rejects(api.__features.validateDashboardProposal(settings,ctx,unsafe));
      await assert.rejects(api.__features.applyDashboardProposal(settings,ctx,unsafe));
      assert.equal(bodies.length,count);assert.equal(reads,0);assert.equal(saved.length,0);
    }
    for(const service of [undefined,()=>undefined,()=>({}),()=>{throw Error('Unavailable registry');}]) {
      runtime.getDataSourceSrv=service;
      const ctx={...context,panels:[{...panel,datasource:'pg',targets:[{...source,datasource:'pg'}]}]};
      assert.deepEqual(api.__features.codeProposalCandidates(ctx,[1],'sql','SELECT 2',settings),[]);
      await assert.rejects(api.__features.validateDashboardProposal(settings,ctx,{panelId:1,targets:[{refId:'B',rawSql:'SELECT 2'}]}),error=>!(error instanceof TypeError));
    }
  } finally {global.fetch=oldFetch;runtime.getDataSourceSrv=oldSrv;}
});
test('failed preview repairs the original interpolated SQL while only execution receives the row bound',async()=>{
  const oldFetch=global.fetch,oldSrv=runtime.getDataSourceSrv;let body;
  runtime.getDataSourceSrv=()=>({getInstanceSettings:()=>pg,get:async()=>({getRef:()=>pg,interpolateVariablesInQueries:queries=>queries.map(query=>({...query,rawSql:query.rawSql.replace('$field','missing')}))})});
  global.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({results:{B:{error:'column missing does not exist',status:400}}}));};
  try {
    const proposal={panelId:1,targets:[{...source,rawSql:'SELECT $field FROM orders'}]};
    const validation=await api.__features.validateDashboardProposal(settings,context,proposal);
    assert.equal(validation.ok,false);assert.match(body.queries[0].rawSql,/__tech_ai_result/);assert.match(body.queries[0].rawSql,/LIMIT 101$/);
    assert.equal(validation.details[0].query.rawSql,'SELECT missing FROM orders');assert.equal(validation.details[0].query.format,'time_series');
    const prompt=api.__features.repairPrompt(validation,settings);
    assert.match(prompt,/SELECT missing FROM orders/);assert.match(prompt,/column missing/);assert.doesNotMatch(prompt,/__tech_ai_result|LIMIT 101/);
    assert.equal(proposal.targets[0].rawSql,'SELECT $field FROM orders');
  } finally {global.fetch=oldFetch;runtime.getDataSourceSrv=oldSrv;}
});
test('UUID fallback is v4 and uses cryptographic randomness without randomUUID',()=>{
  const crypto=require('node:crypto').webcrypto,ids=Array.from({length:100},()=>q.uniqueId({getRandomValues:bytes=>crypto.getRandomValues(bytes)}));
  assert.equal(new Set(ids).size,100);assert.ok(ids.every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
  assert.throws(()=>q.uniqueId({}),/ID/);
});
test('invalid local time remains distinguishable from an intentionally empty incident time',()=>{
  const original=process.env.TZ;try{process.env.TZ='America/New_York';assert.match(q.localTimeError('2026-03-08T02:30',false,false),/не существует/);assert.equal(q.localTimeError('',false,false),'');assert.ok(q.localTimeError('',true,false));assert.ok(q.localTimeError('',false,true));}finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});
test('multi-query code proposal requires explicit target, preserves its options and leaves other targets intact',()=>{
  const second={...source,refId:'C',format:'table',rawSql:'SELECT 7'},multi={...context,panels:[{...panel,targets:[source,second]}]};
  assert.equal(api.__features.codeProposal(multi,[1],'sql','SELECT 8',settings),undefined);
  const proposal=api.__features.codeProposal(multi,[1],'sql','SELECT 8',settings,'C');
  assert.equal(proposal.targets[0].format,'table');assert.equal(proposal.targets[0].refId,'C');assert.equal(proposal.targets[0].rawSql,'SELECT 8');assert.equal(second.rawSql,'SELECT 7');
  assert.equal(api.__features.codeProposal({...context,panels:[{...panel,targets:[source,{...second,refId:undefined}]}]},[1],'sql','SELECT 8',settings,'__target_1'),undefined);
});
test('repair draft caps long SQL, keeps error first and explicitly marks truncation',()=>{
  const validation={range:{from:1,to:2},details:[{refId:'B',error:'missing column 42703',query:{rawSql:'SELECT '+ 'field,'.repeat(3900)+'tail'}}]};
  const prompt=api.__features.repairPrompt(validation,settings);
  assert.ok(prompt.length<=8000);assert.match(prompt,/missing column 42703/);assert.match(prompt,/сокращён/);assert.ok(validation.details[0].query.rawSql.endsWith('tail'));
});
test('curated JSON/array/string functions remain readable while I/O, state and unreviewed functions stay blocked',()=>{
  for(const sql of ["SELECT to_jsonb(orders) FROM orders", "SELECT jsonb_path_query('[1,2]'::jsonb, '$[*]')",'SELECT array_length(ARRAY[1,2],1)',"SELECT string_to_array('a,b', ',')","SELECT regexp_split_to_table('a,b', ',')","SELECT format('%s', 'SELECT; DELETE')"]) assert.doesNotThrow(()=>q.boundedSql(sql),sql);
  for(const sql of ["SELECT pg_read_file('x')","SELECT dblink('x','y')","SELECT lo_import('x')","SELECT set_config('x','y',false)","SELECT nextval('s')","SELECT setval('s',1)",'SELECT public.to_jsonb(1)','SELECT arbitrary_function(1)']) assert.throws(()=>q.boundedSql(sql),sql);
});
test('target diff exposes all saved metadata while SQL-only edits remain compact',()=>{
  const before={...source,hide:false}, proposed={refId:'B',rawSql:source.rawSql,format:'table',hide:true};
  const lines=q.targetDiff(before,proposed);
  assert.ok(lines.some(line=>line.type==='add'&&line.text.includes('"hide": true')));
  assert.ok(lines.some(line=>line.type==='add'&&line.text.includes('"format": "table"')));
  assert.deepEqual(q.targetDiff(before,{refId:'B',rawSql:'SELECT 2'}),q.diffLines(source.rawSql,'SELECT 2'));
  assert.ok(q.targetDiff(before,{refId:'B',datasource:{uid:'other',type:pg.type}}).some(line=>line.type==='add'&&line.text.includes('other')));
  assert.ok(q.targetDiff({...before,expr:'up'},{refId:'B',rawSql:'SELECT 3'}).some(line=>line.type==='add'&&line.text.includes('SELECT 3')));
});
test('untrusted proposal parser rejects malformed targets, duplicate IDs and non-string expressions before rendering',()=>{
  const parse=targets=>api.__test.parseDashboardProposal('```dashboard-json\n'+JSON.stringify({panelId:1,targets})+'\n```');
  for(const targets of [[null],['SELECT 1'],[[]],[{refId:1}],[{refId:' '}],[{rawSql:{sql:'SELECT 1'}}],[{expr:42}],[{datasource:42}],[{datasource:{uid:{}}}],[{refId:'A'},{refId:'A'}],Array.from({length:21},(_,i)=>({refId:String(i)}))]) assert.equal(parse(targets),undefined);
  assert.equal(api.__test.parseDashboardProposal('```dashboard-json\n{"panelId":1,"targets":[{"__proto__":{}}]}\n```'),undefined);
  assert.ok(parse([{refId:'B',rawSql:'SELECT 1',format:'table'}])); assert.ok(parse([]));
});
test('pending silence survives remount, blocks creation and adopts readback using GET only',async()=>{
  const oldFetch=global.fetch,oldSession=global.sessionStorage,oldLocal=global.localStorage;
  const storage=new Map(),store={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  global.sessionStorage=store;global.localStorage=store;
  const body={matchers:[{name:'service',value:'fixture',isRegex:false,isEqual:true}],startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),comment:'fixture',createdBy:'test'};
  store.setItem('tech-ai-assistant:silence-pending:v1:1',JSON.stringify({at:Date.now(),body,id:'saved'}));
  let state=[],index=0,calls=[];
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),useState:initial=>{const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useEffect:()=>{},useRef:()=>({})};
  const localRuntime={...runtime,config:{bootData:{user:{orgId:1,orgRole:'Admin'}}}};
  const local=factory({AppPlugin},localRuntime,React,{},require('../plugin/attachments'),require('../plugin/conversation'),q,{},a);
  const render=()=>{index=0;return local.__features.AlertSilences({context:{alerting:{instances:[]}}});};
  const nodes=tree=>tree&&typeof tree==='object'?[tree,...tree.children.flatMap(nodes)]:[];
  const find=id=>nodes(render()).find(node=>node.props['data-testid']===id);
  global.fetch=async(url,options)=>{calls.push(options.method);return new Response(JSON.stringify([{...body,id:'saved',startsAt:new Date().toISOString(),status:{state:'active'}}]));};
  try {
    assert.ok(find('tech-ai-silence-pending'));assert.equal(find('tech-ai-silence-apply').props.disabled,true);
    await find('tech-ai-silence-reconcile').props.onClick();
    assert.deepEqual(calls,['GET']);assert.equal(find('tech-ai-silence-pending'),undefined);assert.equal(store.getItem('tech-ai-assistant:silence-pending:v1:1'),null);
    assert.ok(find('tech-ai-silence-apply').children.includes('Сохранить silence'));
    assert.equal(find('tech-ai-silence-confirm').props.checked,false);assert.equal(find('tech-ai-silence-apply').props.disabled,true);
  } finally {global.fetch=oldFetch;global.sessionStorage=oldSession;global.localStorage=oldLocal;}
});
