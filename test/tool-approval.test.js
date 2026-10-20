const test = require('node:test');
const assert = require('node:assert/strict');
let factory;
global.define = (_deps, fn) => { factory = fn; };
delete require.cache[require.resolve('../plugin/module')]; require('../plugin/module'); delete global.define;
class AppPlugin { constructor() { return new Proxy(this, { get: () => () => this }); } setRootPage() { return this; } addConfigPage() { return this; } addLink() { return this; } addComponent() { return this; } }
const moduleApi = factory({ AppPlugin, BusEventWithPayload: class {} }, { config: {} }, { createElement: () => null }, {}, require('../plugin/attachments'), require('../plugin/conversation'), require('../plugin/query-tools'), {}, require('../plugin/alerting'));
const t = moduleApi.__test;
const args = i => ({ datasourceUid: 'pg', query: { rawSql: 'SELECT ' + i }, reason: 'hypothesis ' + i });
const call = (i, type = 'query') => ({ id: String(i), type: 'function', function: { name: type === 'query' ? 'query_grafana_datasource' : 'explore_datasource_schema', arguments: JSON.stringify(args(i)) } });
test('native and text plans wait for selection; only exact approved args run and skips are visible', async () => {
  for (const mode of ['native', 'text']) {
    let approve, planned, rounds = 0; const executed = [];
    const pending = t.runAssistant({ ...t.defaults, toolsMode: mode }, { timeRange: { from: 100, to: 200 } }, '{}', [], {
      queries: true, schema: true,
      post: async () => rounds++ ? { content: 'Done', toolCalls: [] } : { content: mode === 'text' ? '```grafana-query\n' + JSON.stringify(args(1)) + '\n```\n```grafana-schema\n' + JSON.stringify(args(2)) + '\n```' : '', toolCalls: mode === 'native' ? [call(1), call(2, 'schema')] : [] },
      onToolPlan: plan => { planned = plan; return new Promise(resolve => { approve = resolve; }); },
      executeQuery: async (_s, _c, args) => { executed.push(args); return {}; }, executeSchema: async (_s, _c, args) => { executed.push(args); return {}; },
    });
    while (!approve) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(executed, []); assert.equal(planned.calls.length, 2); assert.equal(planned.calls[1].tool, 'schema');
    planned.calls[1].args.query.rawSql = 'changed'; planned.range.to = 999;
    approve([1]); const result = await pending;
    assert.deepEqual(executed, [args(2)]); assert.equal(result.steps.length, 2); assert.match(result.steps[0].error, /пропущен/);
  }
});
test('abort while waiting rejects immediately and no query escapes; default mode keeps existing behavior', async () => {
  const controller = new AbortController(); let planned, calls = 0, rounds = 0;
  const options = { queries: true, signal: controller.signal, post: async () => ({ content: '', toolCalls: [call(1)] }), onToolPlan: () => { planned = true; return new Promise(() => {}); }, executeQuery: async () => { calls++; return {}; } };
  const pending = t.runAssistant({ ...t.defaults, toolsMode: 'native' }, {}, '{}', [], options);
  while (!planned) await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 0);
  await t.runAssistant({ ...t.defaults, toolsMode: 'native' }, {}, '{}', [], { ...options, signal: undefined, onToolPlan: undefined, post: async () => rounds++ ? { content: 'Done', toolCalls: [] } : { content: '', toolCalls: [call(1)] } }); assert.equal(calls, 1);
});
test('skip all preserves query budget; plan mode still shares schema/query limits and round cap', async () => {
  let executed = 0, rounds = 0, plans = [];
  await t.runAssistant({ ...t.defaults, toolsMode: 'native', aiQueryMaxPerTurn: 1 }, {}, '{}', [], { queries: true, schema: true, post: async () => ++rounds === 3 ? { content: 'Done', toolCalls: [] } : { content: '', toolCalls: [call(1), call(2, 'schema')] }, onToolPlan: p => { plans.push(p.remaining); return plans.length === 1 ? [] : [0, 1]; }, executeQuery: async () => { executed++; return {}; }, executeSchema: async () => { executed++; return {}; } });
  assert.deepEqual(plans, [1, 1]); assert.equal(executed, 1);
});
