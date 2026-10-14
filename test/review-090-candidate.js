const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node test/review-090-candidate.js <candidate-directory>');
let factory;
const sandbox = { define: (_deps, fn) => { factory = fn; }, URLSearchParams, AbortController, setTimeout, clearTimeout, location: { search: '' } };
const source = fs.readFileSync(path.join(directory, 'module.js'), 'utf8');
assert.ok(source.includes('return { plugin };'));
vm.runInNewContext(source.replace('return { plugin };', 'return { plugin, review: { defaults, runAssistant, executeSchemaTool, parseAroundTimeRange, snapshotKey, capturePanelCanvasScreenshot } };'), sandbox);
class AppPlugin { constructor() { const proxy = new Proxy(this, { get: () => () => proxy }); return proxy; } }
let requested;
const runtime = { config: { appSubUrl: '/crf/dashboard', bootData: { user: { orgRole: 'Admin' } } }, getBackendSrv: () => ({ get: async url => { requested = url; return { data: [] }; } }) };
const t = factory({ AppPlugin, BusEventWithPayload: class {} }, runtime, { createElement: () => null }, {}, require(path.resolve(directory, 'attachments.js')), require(path.resolve(directory, 'conversation.js')), require(path.resolve(directory, 'query-tools.js'))).review;
(async () => {
  let posts = 0, validations = 0;
  await t.runAssistant(t.defaults, { panels: [{ id: 1 }] }, '{}', [{ role: 'user', content: 'Help' }], {
    queries: false,
    post: async () => { posts++; return { content: '```dashboard-json\n{"panelId":1,"targets":[{"expr":"up"}]}\n```', toolCalls: [] }; },
    validateProposal: async () => { validations++; return { ok: false, error: 'Permission denied' }; },
  });
  assert.equal(validations, 2);
  assert.equal(posts, 2);
  console.log('queries=false: 2 validations and 2 model rounds, including repair for a permission error');
  await t.executeSchemaTool(t.defaults, { panels: [{ datasource: { uid: 'correct', type: 'prometheus' } }] }, { datasourceUid: 'nonexistent', action: 'metrics' });
  assert.ok(requested.includes('/uid/correct/'));
  console.log('Unknown datasource UID silently queries the first datasource');
  const range = t.parseAroundTimeRange('2050-01-01T00:00:00Z', { from: '2026-10-01T00:00:00Z', to: '2026-10-01T01:00:00Z' }, 60);
  assert.ok(range.from > Date.parse('2026-10-01T01:00:00Z'));
  console.log('aroundTime can escape the confirmed time range');
  const before = { panels: [{ id: 1, targets: [{ expr: 'up' }] }], timeRange: { from: 'now-1h', to: 'now' }, variables: {} };
  const after = { ...before, panels: [{ id: 1, targets: [{ expr: 'rate(errors_total[5m])' }] }] };
  assert.equal(t.snapshotKey(before, [1], t.defaults, {}), t.snapshotKey(after, [1], t.defaults, {}));
  console.log('Changing a query does not invalidate the data snapshot key');
  let drawn;
  const otherCanvas = { width: 400, height: 200, closest: () => null };
  const selectedTable = { closest: () => null, querySelectorAll: () => [] };
  const ctx = { fillRect() {}, strokeRect() {}, fillText() {}, drawImage(source) { drawn = source; } };
  sandbox.document = { querySelector: selector => selector.includes('panel-1') || selector.includes('grid-item-1') || selector.includes('panelid="1"') ? selectedTable : null, querySelectorAll: selector => selector === 'canvas' ? [otherCanvas] : [], createElement: () => ({ getContext: () => ctx, toDataURL: () => 'data:image/jpeg;base64,AA==' }) };
  const screenshot = t.capturePanelCanvasScreenshot({ panels: [{ id: 1, title: 'Selected table' }] }, [1]);
  assert.ok(screenshot);
  assert.equal(drawn, otherCanvas);
  console.log('Selected table without canvas falls back to an unrelated canvas');
})().catch(error => { console.error(error); process.exitCode = 1; });
