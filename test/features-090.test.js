const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
let factory;
global.define = (_deps, fn) => { factory = fn; };
delete require.cache[require.resolve('../plugin/module.js')];
require('../plugin/module.js');
delete global.define;
class AppPlugin { constructor() { const proxy = new Proxy(this, { get: () => () => proxy }); return proxy; } }
const runtime = { config: { appSubUrl: '/crf/dashboard', bootData: { user: { orgId: 1, orgRole: 'Admin' } } }, getDataSourceSrv: () => ({ getInstanceSettings: uid => uid === 'prom' ? { uid, type: 'prometheus' } : undefined }) };
const moduleApi = factory({ AppPlugin, BusEventWithPayload: class {} }, runtime, { createElement: () => null }, {}, require('../plugin/attachments.js'), require('../plugin/conversation.js'), require('../plugin/query-tools.js'));
const f = moduleApi.__features, t = moduleApi.__test;
const settings = { ...t.defaults };
const from = Date.parse('2026-10-14T09:00:00Z'), to = from + 3600000;
const panel = { id: 1, title: 'CPU', datasource: { uid: 'prom', type: 'prometheus' }, targets: [{ refId: 'A', expr: 'up' }] };
const context = { dashboardUid: 'tech', dashboardVersion: 2, panels: [panel], timeRange: { from, to }, variables: {} };
const originalFetch = global.fetch;
const originalLocation = global.location;
test.after(() => { global.fetch = originalFetch; global.location = originalLocation; });
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('пик ограничен подтверждённым периодом; неверное время не запускает запрос', async () => {
  assert.deepEqual(f.aroundTimeRange(from + 30000, context, 4), { from, to: from + 150000 });
  assert.throws(() => f.aroundTimeRange(to + 1, context, 4), /вне/);
  assert.throws(() => f.aroundTimeRange('invalid', context, 4), /ISO/);
  let calls = 0;
  global.fetch = async () => { calls++; return reply({ results: {} }); };
  await assert.rejects(f.executeQueryTool(settings, context, { datasourceUid: 'prom', query: { expr: 'up' }, aroundTime: to + 1 }), /вне/);
  assert.equal(calls, 0);
});

test('запрос вокруг пика отправляет точный узкий период', async () => {
  let body;
  global.fetch = async (_url, options) => { body = JSON.parse(options.body); return reply({ results: {} }); };
  const result = await f.executeQueryTool(settings, context, { datasourceUid: 'prom', query: { expr: 'up' }, aroundTime: from + 300000, windowMinutes: 4 });
  assert.equal(Number(body.from), from + 180000);
  assert.equal(Number(body.to), from + 420000);
  assert.equal(result.range.from, new Date(from + 180000).toISOString());
});

test('разведка требует известный datasource, allowlist, тип и разрешённое действие', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return reply({ data: [] }); };
  await assert.rejects(f.executeSchemaTool(settings, context, { datasourceUid: 'other', action: 'labels' }), /отсутствует/);
  await assert.rejects(f.executeSchemaTool({ ...settings, allowedDatasourceUids: 'other' }, context, { datasourceUid: 'prom', action: 'labels' }), /allowlist/);
  await assert.rejects(f.executeSchemaTool({ ...settings, schemaDiscoveryEnabled: false }, context, { datasourceUid: 'prom', action: 'labels' }), /отключена/);
  await assert.rejects(f.executeSchemaTool(settings, context, { datasourceUid: 'prom', action: 'tables' }), /Неподдерживаемое/);
  await assert.rejects(f.executeSchemaTool(settings, context, { datasourceUid: 'prom', action: 'label_values', label: '../foo' }), /имя label/);
  assert.equal(calls, 0);
});

test('разведка передаёт серверу период и фильтр метрик; выходная выборка ограничена', async () => {
  let requested;
  global.fetch = async url => { requested = new URL(url, 'http://localhost'); return reply({ status: 'success', data: Array.from({ length: 150 }, (_, i) => 'http.requests_' + i) }); };
  const result = await f.executeSchemaTool(settings, context, { datasourceUid: 'prom', action: 'metrics', match: 'http.requests' });
  assert.equal(requested.pathname, '/crf/dashboard/api/datasources/proxy/uid/prom/api/v1/label/__name__/values');
  assert.equal(Number(requested.searchParams.get('start')), from / 1000);
  assert.ok(requested.searchParams.get('match[]').includes('http\\\\.requests'));
  assert.equal(result.items.length, 100);
  assert.equal(result.total, 150);
  assert.equal(result.truncated, true);
});

test('таймаут и отмена прерывают запрос метаданных', async () => {
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(f.grafanaRequest('/api/annotations', { timeoutMs: 10 }), /не уложился/);
  const controller = new AbortController();
  const request = f.grafanaRequest('/api/annotations', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
});

test('разведка и запросы данных делят один бюджет; схема выключена без согласия', async () => {
  let schemaCalls = 0, queryCalls = 0, round = 0;
  const post = async () => ({ content: round++ ? 'Done' : '```grafana-schema\n{"datasourceUid":"prom","action":"labels"}\n```\n```grafana-query\n{"datasourceUid":"prom","query":{"expr":"up"}}\n```', toolCalls: [] });
  const result = await t.runAssistant({ ...settings, aiQueryMaxPerTurn: 1 }, context, '{}', [], { queries: true, schema: true, post, executeSchema: async () => { schemaCalls++; return { kind: 'schema', items: ['job'], action: 'labels', total: 1 }; }, executeQuery: async () => { queryCalls++; return {}; } });
  assert.equal(schemaCalls, 1); assert.equal(queryCalls, 0);
  assert.ok(result.steps[1].error.includes('лимит'));
  round = 0; schemaCalls = 0;
  await t.runAssistant(settings, context, '{}', [], { queries: true, schema: false, post, executeSchema: async () => { schemaCalls++; return {}; }, executeQuery: async () => ({}) });
  assert.equal(schemaCalls, 0);
});

test('native schema tool присутствует только при явном разрешении', () => {
  assert.equal(t.requestBody(settings, '{}', [], { mode: 'native' }).tools.length, 1);
  assert.equal(t.requestBody(settings, '{}', [], { mode: 'native', schema: true }).tools.length, 2);
});

test('обычный ответ с dashboard-json не вызывает проверку или самоисправление', async () => {
  let fetches = 0, posts = 0;
  global.fetch = async () => { fetches++; return reply({}); };
  await t.runAssistant(settings, context, '{}', [], { queries: false, post: async () => { posts++; return { content: '```dashboard-json\n{"panelId":1,"targets":[{"expr":"bad"}]}\n```', toolCalls: [] }; } });
  assert.equal(posts, 1); assert.equal(fetches, 0);
});

test('ручная проверка выполняет только выбранный target и использует исторический период', async () => {
  let body;
  global.fetch = async (_url, options) => { body = JSON.parse(options.body); return reply({ results: { B: { frames: [] } } }); };
  const proposed = [{ refId: 'A', expr: 'a' }, { refId: 'B', expr: 'b' }];
  const result = await f.validateDashboardProposal(settings, context, { panelId: 1, targets: proposed, selectedTargets: { targets: proposed, ids: ['B'] } });
  assert.equal(body.queries.length, 1); assert.equal(body.queries[0].refId, 'B');
  assert.equal(Number(body.from), from); assert.equal(Number(body.to), to);
  assert.equal(result.ok, true); assert.equal(result.empty, true);
});

test('проверка отвергает отсутствующую панель, новый источник и слишком много targets', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return reply({}); };
  await assert.rejects(f.validateDashboardProposal(settings, context, { panelId: 99, targets: [{ expr: 'a' }] }), /отсутствует/);
  await assert.rejects(f.validateDashboardProposal(settings, context, { panelId: 1, targets: [{ expr: 'a', datasource: { uid: 'other' } }] }), /новый/);
  await assert.rejects(f.validateDashboardProposal({ ...settings, maxTargetsPerPanel: 1 }, context, { panelId: 1, targets: [{ expr: 'a' }, { expr: 'b' }] }), /от 1 до 1/);
  assert.equal(calls, 0);
});

test('редактирование targets или datasource меняет ключ снимка', () => {
  const key = t.snapshotKey(context, [1], settings, {});
  assert.notEqual(key, t.snapshotKey({ ...context, panels: [{ ...panel, targets: [{ expr: 'changed' }] }] }, [1], settings, {}));
  assert.notEqual(key, t.snapshotKey({ ...context, panels: [{ ...panel, datasource: { uid: 'other', type: 'prometheus' } }] }, [1], settings, {}));
});

test('Explore сохраняет queries, периоды panes и неизвестный тип без подмены', async () => {
  const panels = await f.parseExplorePanes(new URLSearchParams({ panes: JSON.stringify({ a: { datasource: 'prom', range: { from, to }, queries: [{ expr: 'up' }] }, b: { datasource: 'unknown', range: { from: from - 1000, to }, queries: [{ expr: 'x' }] } }) }));
  assert.equal(panels.length, 2); assert.equal(panels[0].targets[0].datasource.type, 'prometheus');
  assert.equal(panels[1].datasource.type, undefined);
  assert.equal(t.selectContextPanels({ isExplore: true, panels, timeRange: {} }, [2]).timeRange.from, from - 1000);
  assert.throws(() => f.parseExplorePanes(new URLSearchParams({ panes: '{bad' })), /Некорректный/);
});

test('несохранённые queries берутся только из реального extension context', () => {
  global.location = { search: '' };
  const next = f.mergeExtensionQueries(context, { panelId: 1, panel: { targets: [{ refId: 'A', expr: 'changed' }] } });
  assert.equal(next.panels[0].targets[0].expr, 'changed'); assert.equal(next.panels[0].hasUnsavedChanges, true);
  assert.equal(context.panels[0].targets[0].expr, 'up');
});

test('события не запрашиваются без выбора; ошибки не выдаются за пустые события', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return reply({ message: 'Permission denied' }, 403); };
  assert.deepEqual(await f.loadInvestigationEvents(settings, context, { range: { from, to } }), {});
  assert.equal(calls, 0);
  const events = await f.loadInvestigationEvents(settings, context, { range: { from, to }, annotations: true });
  assert.ok(events.annotationsStatus.includes('Не получено')); assert.equal(events.annotations, undefined);
  assert.equal(calls, 1);
});

test('аннотации ограничены выбранными панелями, версии сравнивают правильную пару', async () => {
  const urls = [];
  global.fetch = async url => {
    urls.push(url);
    if (url.includes('/api/annotations?')) return reply([{ panelId: 1, time: from, text: 'Deploy' }, { panelId: 2, time: from, text: 'Other panel' }]);
    if (url.includes('/versions?')) return reply([{ version: 1 }, { version: 2 }]);
    return reply({ data: { panels: [{ ...panel, targets: [{ refId: 'A', expr: 'previous' }] }] } });
  };
  const events = await f.loadInvestigationEvents(settings, context, { annotations: true, versions: true, range: { from, to } });
  assert.equal(events.annotations.length, 1); assert.equal(events.versionChanges.previousVersion, 1);
  assert.equal(events.versionChanges.modifiedPanels[0].changes[0].before, 'previous');
  assert.ok(urls[0].includes('dashboardUID=tech'));
});

test('создание аннотации отправляет только явный черновик и нужный dashboard UID', async () => {
  let body;
  global.fetch = async (_url, options) => { body = JSON.parse(options.body); return reply({ id: 1 }); };
  await f.createDashboardAnnotation(context, { timeMs: from, panelId: 1, text: 'Incident' });
  assert.equal(body.dashboardUID, 'tech'); assert.equal(body.panelId, 1); assert.equal(body.time, from);
  await assert.rejects(f.createDashboardAnnotation({}, { timeMs: from, text: 'x' }), /сохранённый/);
});

test('Canvas выбранной таблицы не подменяется чужим графиком', () => {
  const previous = global.document;
  let globalCanvasSearch = 0;
  global.document = { querySelector: () => ({ closest: () => null, querySelectorAll: () => [] }), querySelectorAll: () => { globalCanvasSearch++; return []; } };
  try { assert.throws(() => f.capturePanelCanvases(context, [1]), /чужие графики/); assert.equal(globalCanvasSearch, 0); }
  finally { global.document = previous; }
});
