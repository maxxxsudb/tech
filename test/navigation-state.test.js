const test = require('node:test');
const assert = require('node:assert/strict');
let factory, Assistant, state = [], refs = [], effects = [], queue = [], si = 0, ri = 0, ei = 0;
global.define = (_, fn) => { factory = fn; }; delete require.cache[require.resolve('../plugin/module')]; require('../plugin/module'); delete global.define;
class AppPlugin {
  setRootPage() { return this; } addConfigPage() { return this; }
  addComponent(value) { Assistant = value.component; return this; } addLink() { return this; }
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), Fragment: 'fragment',
  useState(initial) { const i = si++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
  useRef(initial) { const i = ri++; return refs[i] ||= { current: initial }; },
  useEffect(fn, deps) { const i = ei++, old = effects[i]; if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects[i] = { deps, cleanup: old && old.cleanup }; queue.push(() => { if (effects[i].cleanup) effects[i].cleanup(); effects[i].cleanup = fn(); }); } },
};
const listeners = new Set();
const pg = { uid: 'pg', type: 'grafana-postgresql-datasource' };
const runtime = { config: { appSubUrl: '/grafana', bootData: { user: { orgId: 1, orgRole: 'Admin' } } }, locationService: { getHistory: () => ({ listen(fn) { listeners.add(fn); return () => listeners.delete(fn); } }) }, getBackendSrv: () => ({ get: async path => path.includes('/settings') ? { jsonData: { includePanelData: false, previewBeforeSend: 'never' } } : { dashboard: { uid: path.split('/').at(-1), title: path.split('/').at(-1), panels: [1, 2].map(id => ({ id, title: `Panel ${id}`, datasource: pg, targets: [{ refId: 'A', rawSql: `select ${id}`, format: 'table' }] })) } } }), getDataSourceSrv: () => ({ getInstanceSettings: () => pg }) };
factory({ AppPlugin, BusEventWithPayload: class {} }, runtime, React, {}, require('../plugin/attachments'), require('../plugin/conversation'), require('../plugin/query-tools'), {}, require('../plugin/alerting'));
const originals = Object.fromEntries(['location', 'window', 'sessionStorage', 'fetch', 'setInterval', 'clearInterval'].map(key => [key, global[key]]));
const storage = new Map(), timers = new Set();
global.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
global.setInterval = fn => { timers.add(fn); return fn; }; global.clearInterval = fn => timers.delete(fn);
test.after(() => { for (const effect of effects) if (effect && effect.cleanup) effect.cleanup(); for (const [key, value] of Object.entries(originals)) global[key] = value; });
function navigate(path) { const url = new URL(path, 'http://localhost'); global.location = { pathname: url.pathname, search: url.search, href: url.href }; global.window = { location: global.location }; for (const fn of [...listeners]) fn(); }
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
let props = {};
function render() { si = ri = ei = 0; const tree = Assistant(props); const pending = queue; queue = []; pending.forEach(fn => fn()); return tree; }
async function flush() { for (let i = 0; i < 8; i++) { render(); await new Promise(resolve => setImmediate(resolve)); } return render(); }
function button(tree, label) { const found = nodes(tree).find(node => node.type === 'button' && node.children.includes(label)); assert.ok(found, label); return found; }
function reset(path, initialContext) {
  for (const effect of effects) if (effect && effect.cleanup) effect.cleanup();
  state = []; refs = []; effects = []; queue = []; storage.clear(); props = { initialContext };
  navigate(path); render();
}

test('real Assistant effects switch context/history, abort in-flight reply and discard its late completion', async () => {
  reset('/grafana/d/a/title'); await flush();
  assert.equal(state[1].dashboardUid, 'a'); assert.deepEqual(state[15], [1, 2]);
  let resolveOld, oldSignal;
  global.fetch = (_url, options) => { oldSignal = options.signal; return new Promise(resolve => { resolveOld = resolve; }); };
  const area = nodes(render()).find(node => node.type === 'textarea');
  area.props.onChange({ target: { value: 'Investigate A' }, currentTarget: { getBoundingClientRect: () => ({ height: 42 }) } });
  button(render(), 'Отправить').props.onClick(); await flush();
  assert.equal(state[6], true); assert.equal(state[3][0].content, 'Investigate A');
  refs[0].current = { panelData: [{ panelId: 1 }] };
  navigate('/grafana/d/b/title'); assert.equal(oldSignal.aborted, true); await flush();
  assert.equal(state[1].dashboardUid, 'b'); assert.equal(state[2], 'tech-ai-chat:b'); assert.deepEqual(state[3], []); assert.equal(refs[0].current, undefined);
  resolveOld(new Response(JSON.stringify({ choices: [{ message: { content: 'Old answer from A' } }] }))); await flush();
  assert.deepEqual(state[3], []); assert.equal(state[6], false);
  navigate('/grafana/d/a/title'); await flush();
  assert.equal(state[1].dashboardUid, 'a'); assert.equal(state[3][0].content, 'Investigate A');
});

test('panel to dashboard to Explore does not reuse the initial extension or old panels', async () => {
  reset('/grafana/d/a/title?viewPanel=panel-1', { panelId: 1 }); await flush();
  assert.equal(state[1].panel.id, 1); assert.equal(state[2], 'tech-ai-chat:a:panel-1');
  navigate('/grafana/d/a/title'); await flush(); assert.equal(state[1].panel, undefined); assert.equal(state[1].panels.length, 2);
  const panes = { a: { datasource: pg, queries: [{ refId: 'A', rawSql: 'select 99', format: 'table' }], range: { from: 'now-1h', to: 'now' } } };
  navigate('/grafana/explore?panes=' + encodeURIComponent(JSON.stringify(panes))); await flush();
  assert.equal(state[1].isExplore, true); assert.equal(state[1].dashboardUid, undefined); assert.equal(state[1].panels[0].targets[0].rawSql, 'select 99');
});

test('dashboard to Alerting switches to the rule and its PostgreSQL query without running it', async () => {
  reset('/grafana/d/a/title'); await flush();
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const body = url.includes('/provisioning/') ? { uid: 'r1', title: 'SQL alert', data: [{ refId: 'Q', datasourceUid: 'pg', model: { rawSql: 'select failure_count from incidents', format: 'table' } }] } : url.includes('/prometheus/') ? { status: 'success', data: { groups: [] } } : [];
    return new Response(JSON.stringify(body));
  };
  navigate('/grafana/alerting/grafana/r1/view'); await flush();
  assert.equal(state[1].isAlerting, true); assert.equal(state[1].dashboardUid, undefined); assert.equal(state[1].alerting.rule.uid, 'r1');
  assert.equal(state[1].panels[0].targets[0].rawSql, 'select failure_count from incidents');
  assert.equal(state[2], 'tech-ai-chat:org-1:alert-r1'); assert.deepEqual(state[3], []);
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.options.method === 'GET' && !call.url.includes('/ds/query')));
});
