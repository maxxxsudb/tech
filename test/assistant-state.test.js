const test = require("node:test");
const assert = require("node:assert/strict");
let factory, Assistant, state = [], refs = [], stateIndex, refIndex;
global.define = (_deps, fn) => { factory = fn; };
delete require.cache[require.resolve('../plugin/module.js')];
require("../plugin/module.js");
delete global.define;
class AppPlugin {
  setRootPage() { return this; }
  addConfigPage() { return this; }
  addComponent(value) { Assistant = value.component; return this; }
  addLink() { return this; }
}
// Выполняем настоящие обработчики Assistant без сети и эффектов загрузки Grafana.
const React = {
  Fragment: "fragment",
  createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
  useState(initial) { const i = stateIndex++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === "function" ? value(state[i]) : value; }]; },
  useRef(initial) { const i = refIndex++; return refs[i] ||= { current: initial }; },
  useEffect() {},
};
const runtime = { config: { appSubUrl: "/crf/dashboard", bootData: { user: { orgId: 1, orgRole: "Admin" } } } };
const moduleApi = factory({ AppPlugin, BusEventWithPayload: class {} }, runtime, React, {}, require("../plugin/attachments.js"), require("../plugin/conversation.js"), require("../plugin/query-tools.js"), {}, require("../plugin/alerting.js"));
global.location = { search: "", href: "http://localhost/crf/dashboard/d/tech/tech-stand" };
global.window = { location: global.location };
const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; delete global.location; delete global.window; });
function render() { stateIndex = refIndex = 0; return Assistant({}); }
function nodes(tree) { return tree && typeof tree === "object" ? [tree, ...tree.children.flatMap(nodes)] : []; }
function button(tree, label) { const found = nodes(tree).find(n => n.type === "button" && n.children.includes(label)); assert.ok(found, label); return found; }
function reset(files = [], settings = {}) {
  state = []; refs = []; render();
  state[0] = { ...moduleApi.__test.defaults, provider: "custom", apiPath: "/v1/chat/completions", model: "mock", streaming: false, previewBeforeSend: "never", includePanelData: false, ...settings };
  state[1] = { dashboardUid: "tech", dashboardTitle: "Tech", panels: [], timeRange: { from: "now-1h", to: "now" } };
  state[5] = "Test"; state[9] = files;
}
function image(id = "image") { return { id, name: id + ".png", kind: "image", asText: true, bytes: 3, dataUrl: "data:image/jpeg;base64,AAAA" }; }
function response(text, finishReason = "stop") { return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { "content-type": "application/json" } }); }
const settle = () => new Promise(resolve => setImmediate(resolve));
async function waitDone() { for (let i = 0; i < 100 && state[6]; i++) await settle(); assert.equal(state[6], false); }

test("во время ответа можно писать черновик, Enter не отправляет его и завершение не очищает", async () => {
  reset(); let finish, calls = 0;
  global.fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  button(render(), "Отправить").props.onClick(); await settle();
  assert.equal(state[5], "");
  const area = nodes(render()).find(node => node.type === "textarea");
  assert.equal(area.props.disabled, false);
  area.props.onChange({ target: { value: "Next question" }, currentTarget: { getBoundingClientRect: () => ({ height: 110 }) } });
  let prevented = false;
  area.props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false); assert.equal(calls, 1);
  finish(response("Answer")); await waitDone();
  assert.equal(state[5], "Next question"); assert.equal(refs[12].current.height, 110); assert.equal(calls, 1);
});

test("ошибка до отправки вопроса возвращает текст и не затирает новый черновик", async () => {
  for (const draft of ["", "Next question"]) {
    reset([], { includePanelData: true });
    state[1].panels = [{ id: 1, title: "CPU", datasource: { uid: "loki", type: "loki" }, targets: [{ refId: "A", expr: "up" }] }]; state[15] = [1];
    let finish;
    global.fetch = () => new Promise(resolve => { finish = resolve; });
    state[25] = "sample";
    button(render(), "Отправить").props.onClick(); await settle();
    state[5] = draft;
    finish(new Response('{"message":"Error"}', { status: 503 })); await settle();
    if (state[6]) finish(new Response('{"error":{"message":"No model"}}', { status: 503 }));
    await waitDone();
    assert.equal(state[5], draft || "Test");
  }
});

test("подготовка алерта открывает builder без модели, datasource и записи", () => {
  reset(); state[1].panels = [{ id: 1, title: "SQL", datasource: { uid: "pg", type: "grafana-postgresql-datasource" }, targets: [{ refId: "A", rawSql: "SELECT 1" }] }]; state[15] = [1];
  let calls = 0; global.fetch = async () => { calls++; return response("unexpected"); };
  button(render(), "Подготовить алерт").props.onClick();
  assert.ok(nodes(render()).some(node => node.type === moduleApi.__features.AlertDraftEditor)); assert.equal(calls, 0); assert.equal(state[3].length, 0);
});

test("действие одной панели открывает выбор в чате вместо ошибки и запросов", () => {
  reset(); state[1].panels = [{ id: 1, title: "CPU", targets: [] }, { id: 2, title: "RAM", targets: [] }]; state[15] = [1, 2];
  let calls = 0; global.fetch = async () => { calls++; return response("Answer"); };
  button(render(), "Исправить запрос").props.onClick();
  assert.equal(state[7], ""); assert.equal(state[20], "chat"); assert.equal(state[30], true); assert.equal(calls, 0);
  const popup = byId(render(), "tech-ai-context-popover");
  assert.equal(popup.props["aria-label"], "Выберите панель");
  nodes(popup).find(node => node.props["data-panel-id"] === "2").props.onClick();
  assert.deepEqual(state[15], [2]); assert.equal(state[31].selected, 2); assert.equal(calls, 0);
});

test("подпись отправки свёрнута и не меняется при выборе другого периода", async () => {
  reset(); state[1].panels = [{ id: 1, title: "CPU", targets: [] }]; state[15] = [1];
  global.fetch = async () => response("Answer");
  button(render(), "Отправить").props.onClick(); await waitDone();
  const before = JSON.stringify(state[3][0].sentContext);
  state[1].timeRange = { from: "now-24h", to: "now" };
  const details = byId(render(), "tech-ai-sent-context");
  assert.equal(details.type, "details"); assert.ok(!details.props.open);
  assert.equal(JSON.stringify(state[3][0].sentContext), before);
});

test("новый диалог не получает ответ или cleanup старого запроса", async () => {
  reset();
  let rejectOld, finishNew;
  global.fetch = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  button(render(), "Отправить").props.onClick();
  await settle();
  assert.equal(state[3].length, 1);
  button(render(), "Новый диалог").props.onClick();
  assert.equal(state[3].length, 0);
  assert.equal(state[6], false);
  state[5] = "New question";
  global.fetch = () => new Promise(resolve => { finishNew = resolve; });
  button(render(), "Отправить").props.onClick();
  await settle();
  rejectOld(new DOMException("Aborted", "AbortError"));
  await settle();
  assert.equal(state[6], true);
  assert.equal(state[3].length, 1);
  assert.equal(state[3][0].content, "New question");
  finishNew(response("New answer"));
  await waitDone();
  assert.deepEqual(state[3].map(item => item.content), ["New question", "New answer"]);
});

test("поздний успешный ответ не возвращается после очистки чата", async () => {
  reset();
  let finishOld;
  global.fetch = () => new Promise(resolve => { finishOld = resolve; });
  button(render(), "Отправить").props.onClick();
  await settle();
  button(render(), "Новый диалог").props.onClick();
  finishOld(response("Old answer"));
  await settle();
  assert.equal(state[3].length, 0);
  assert.equal(state[4], undefined);
  assert.equal(state[16], undefined);
  assert.equal(state[6], false);
});

test("очистка чата во время OCR не запускает основной запрос и не возвращает вложение", async () => {
  reset([image()], { imageToTextEnabled: true });
  let finishOcr, calls = 0;
  global.fetch = () => { calls++; return new Promise(resolve => { finishOcr = resolve; }); };
  button(render(), "Отправить").props.onClick();
  await settle();
  button(render(), "Новый диалог").props.onClick();
  finishOcr(response("Old transcript"));
  await settle();
  assert.equal(calls, 1);
  assert.equal(state[3].length, 0);
  assert.equal(state[9].length, 0);
  assert.equal(state[16], undefined);
});

test("общий запрет скрывает галку и отправляет картинку без старой расшифровки", async () => {
  reset([{ ...image(), transcript: "OLD_TRANSCRIPT" }]);
  assert.ok(!nodes(render()).some(node => node.props["data-testid"] === "tech-ai-attachment-as-text"));
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response("Answer"); };
  button(render(), "Отправить").props.onClick();
  await waitDone();
  assert.equal(sent.length, 1);
  assert.ok(JSON.stringify(sent[0]).includes("data:image/jpeg;base64,"));
  assert.ok(!JSON.stringify(sent[0]).includes("OLD_TRANSCRIPT"));
});

test("usage включает обе картинки и основной ответ, OCR использует настроенный лимит", async () => {
  reset([image("first"), image("second")], { imageToTextEnabled: true, maxTokens: 2048 });
  assert.equal(nodes(render()).filter(node => node.props["data-testid"] === "tech-ai-attachment-as-text").length, 2);
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response(sent.length <= 2 ? "TRANSCRIPT" : "Answer"); };
  button(render(), "Отправить").props.onClick();
  await waitDone();
  assert.equal(sent.length, 3);
  assert.equal(sent[0].max_tokens, 2048);
  assert.equal(sent[1].max_tokens, 2048);
  assert.ok(!JSON.stringify(sent[2]).includes("data:image/"));
  assert.ok(JSON.stringify(sent[2]).includes("TRANSCRIPT"));
  assert.deepEqual(state[16].usage, { prompt: 300, completion: 60 });
  assert.deepEqual(state[16].transcriptionUsage, { prompt: 200, completion: 40 });
  assert.equal(state[16].transcriptionRequests, 2);
});

test("обрезанный OCR не отправляется как полный контекст, usage остаётся видимым", async () => {
  reset([image()], { imageToTextEnabled: true });
  let calls = 0;
  global.fetch = async () => { calls++; return response("TRUNCATED", "length"); };
  button(render(), "Отправить").props.onClick();
  await waitDone();
  assert.equal(calls, 1);
  assert.match(state[7], /обрезан лимитом токенов/);
  assert.equal(state[3].length, 0);
  assert.deepEqual(state[16].usage, { prompt: 100, completion: 20 });
  assert.equal(state[9][0].transcript, undefined);
});

test("Max output tokens 0 не добавляет жёсткий лимит в запрос OCR", async () => {
  reset([image()], { imageToTextEnabled: true, maxTokens: 0 });
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response("Text"); };
  button(render(), "Отправить").props.onClick();
  await waitDone();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].max_tokens, undefined);
});

test("стартовый экран имеет четыре основных действия и исчезает при отправке", async () => {
  reset();
  const welcome = nodes(render()).find(node => node.props["data-testid"] === "tech-ai-welcome");
  assert.ok(welcome);
  assert.equal(nodes(welcome).filter(node => node.type === "button").length, 4);
  let finish;
  global.fetch = () => new Promise(resolve => { finish = resolve; });
  button(render(), "Отправить").props.onClick();
  await settle();
  assert.ok(!nodes(render()).some(node => node.props["data-testid"] === "tech-ai-welcome"));
  assert.ok(nodes(render()).some(node => node.props["data-testid"] === "tech-ai-request-status"));
  assert.ok(button(render(), "Остановить"));
  finish(response("Answer")); await waitDone();
  assert.ok(!nodes(render()).some(node => node.props["data-testid"] === "tech-ai-request-status"));
});

test("ошибка имеет закрытые подробности и действие повторной отправки", async () => {
  reset();
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "API_DETAILS_083" } }), { status: 502, headers: { "content-type": "application/json" } });
  button(render(), "Отправить").props.onClick(); await waitDone();
  const error = nodes(render()).find(node => node.props["data-testid"] === "tech-ai-error");
  assert.equal(error.props.role, "alert");
  const details = nodes(error).find(node => node.type === "details");
  assert.ok(!details.props.open);
  assert.ok(nodes(details).some(node => node.children.includes(state[7])));
  assert.ok(button(render(), "Повторить"));
});

function byId(tree, id) { const node = nodes(tree).find(node => node.props["data-testid"] === id); assert.ok(node, id); return node; }
function setMode(mode) { byId(render(), "tech-ai-composer-data-mode").props.onChange({ target: { value: mode } }); }
function fixtureSnapshot(stale = false) {
  const dataPlan = { rangeHours: 1, maxPanels: 1, maxTargets: 1, totalTimeoutSeconds: 15, sampleRows: 3 };
  const context = { ...state[1], pageUrl: location.href, variables: {} };
  const snapshot = { key: moduleApi.__test.snapshotKey(context, state[15], state[0], dataPlan), dataPlan, stale, at: Date.now(), range: { from: 0, to: 3600000 }, panelData: [{ panelId: 1, title: "CPU", results: [{ refId: "A", result: { series: [{ name: "CPU", min: 1, max: 2 }] } }] }] };
  refs[0].current = snapshot;
  return snapshot;
}

test("явная структура не наследует данные прежнего снимка", async () => {
  reset([], { includePanelData: true }); fixtureSnapshot();
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response("Answer"); };
  setMode("structure"); button(render(), "Отправить").props.onClick(); await waitDone();
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent).includes('"panelData"'));
  assert.equal(state[3][0].sentContext.data.total, 0);
});

test("готовый снимок используется без запросов datasource, устаревший блокируется", async () => {
  reset([], { includePanelData: true }); fixtureSnapshot();
  const sent = [];
  global.fetch = async (url, options) => { assert.ok(!String(url).includes('/api/ds/query')); sent.push(JSON.parse(options.body)); return response("Answer"); };
  setMode("snapshot"); button(render(), "Отправить").props.onClick(); await waitDone();
  assert.equal(sent.length, 1);
  assert.ok(JSON.stringify(sent).includes('panelData'));
  reset([], { includePanelData: true }); fixtureSnapshot(true); setMode("snapshot");
  button(render(), "Отправить").props.onClick(); await settle();
  assert.equal(sent.length, 1);
  assert.match(state[7], /устарел/);
});

test("Продолжить сохраняет только актуальный снимок и никогда не запрашивает datasource", async () => {
  for (const mode of ['current', 'stale', 'period', 'panels']) {
    reset([], { includePanelData: true }); fixtureSnapshot(mode === 'stale');
    state[3] = [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Partial answer' }];
    if (mode === 'period') state[1].timeRange = { from: 'now-24h', to: 'now' };
    if (mode === 'panels') state[15] = [2];
    const sent = [];
    global.fetch = async (url, options) => { assert.ok(!String(url).includes('/api/ds/query')); sent.push(JSON.parse(options.body)); return response('Continued'); };
    button(render(), 'Продолжить').props.onClick(); await waitDone();
    assert.equal(sent.length, 1);
    const requestContext = JSON.parse(sent[0].messages[0].content.split('Текущий контекст Grafana:\n')[1]);
    assert.equal(Array.isArray(requestContext.panelData), mode === 'current', mode);
  }
});

test("разбор алерта отправляет снимок правила модели без запросов PostgreSQL", async () => {
  reset([], { includePanelData: true });
  state[1] = { isAlerting: true, dashboardTitle: 'SQL alert', timeRange: { from: 1790000000000, to: 1790000060000 }, panels: [], alerting: { mode: 'rule', ruleUid: 'r1', rule: { uid: 'r1', title: 'SQL alert', data: [{ model: { rawSql: 'select count(*) from failures' } }] }, readStatus: {}, loadedAt: new Date().toISOString() } };
  const sent = [];
  global.fetch = async (url, options) => { assert.ok(!String(url).includes('/api/ds/query')); sent.push(JSON.parse(options.body)); return response('Rule explanation'); };
  const card = nodes(render()).find(node => node.type === moduleApi.__features.AlertContextCard);
  card.props.onExplain(); await waitDone();
  assert.equal(sent.length, 1); assert.ok(JSON.stringify(sent).includes('select count(*) from failures'));
  assert.equal(state[3].length, 2);
});

test("поиск панелей не меняет их выбор", () => {
  reset();
  state[1].panels = [{ id: 1, title: "CPU", row: "Servers" }, { id: 2, title: "Memory" }]; state[15] = [1, 2];
  byId(render(), "tech-ai-tab-context").props.onClick();
  byId(render(), "tech-ai-panel-filter").props.onChange({ target: { value: "#2" } });
  const panelTab = byId(render(), "tech-ai-context-tab");
  assert.equal(nodes(panelTab).filter(node => node.type === "input" && node.props.type === "checkbox").length, 2); // Панель + галка снимка.
  assert.deepEqual(state[15], [1, 2]);
  byId(render(), "tech-ai-panel-filter").props.onChange({ target: { value: "missing" } });
  assert.deepEqual(state[15], [1, 2]);
});

test("режим расследования для своего вопроса открывает параметры без отправки", () => {
  reset(); let calls = 0; global.fetch = async () => { calls++; return response("Answer"); };
  setMode("investigation"); button(render(), "Отправить").props.onClick();
  assert.equal(calls, 0); assert.equal(state[13].action.prompt, "Test");
});

test("повтор снимка использует картинку в памяти, её выключение и политика запрещают отправку", async () => {
  for (const policy of ["reuse", "remove", "disabled"]) {
    reset([], { screenshotEnabled: policy !== "disabled" });
    state[8] = true;
    const context = { ...state[1], pageUrl: location.href, variables: {} };
    const capturedScreenshot = { dataUrl: "data:image/jpeg;base64,AAAA", width: 2, height: 2, bytes: 3 };
    state[18] = { prompt: "Retry", action: { capturedScreenshot, screenshotContextKey: JSON.stringify(["tech", moduleApi.__test.snapshotKey(context, state[15], state[0]), "tab"]) } };
    state[7] = "HTTP 502";
    if (policy === "remove") byId(render(), "tech-ai-screenshot-toggle").props.onClick();
    const sent = [];
    global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response("Answer"); };
    button(render(), "Повторить").props.onClick(); await waitDone();
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent).includes('data:image/jpeg;base64,AAAA'), policy === "reuse");
    assert.ok(!JSON.stringify(state[3]).includes('base64'));
    assert.equal(state[8], false);
  }
});

test("ручная высота композера запоминается перед авторостом даже без pointerup", () => {
  reset(); refs[12].current.autoHeight = 42;
  const area = nodes(render()).find(node => node.type === "textarea");
  area.props.onChange({ target: { value: "Long query" }, currentTarget: { getBoundingClientRect: () => ({ height: 110 }) } });
  assert.equal(refs[12].current.height, 110);
  assert.equal(state[5], "Long query");
});

test("завершённые шаги расследования свёрнуты и отмечают ошибки, текущие остаются видимыми", () => {
  reset(); const steps = [{ expr: "up" }, { expr: "broken", error: "timeout" }];
  state[3] = [{ role: "assistant", content: "Answer", steps }];
  const summary = byId(render(), "tech-ai-investigation-steps");
  assert.ok(!summary.props.open);
  assert.ok(nodes(summary).some(node => node.type === "summary" && node.children.some(text => typeof text === "string" && text.includes("есть ошибки"))));
  state[3] = []; state[4] = { content: "", steps }; state[6] = true;
  assert.ok(!nodes(render()).some(node => node.props["data-testid"] === "tech-ai-investigation-steps"));
});

test("черновик аннотации не сохраняется без явного действия", async () => {
  reset(); state[3] = [{ role: "assistant", content: "Incident summary" }];
  const sent = [];
  global.fetch = async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return new Response('{"id":1}'); };
  button(render(), "В аннотацию").props.onClick();
  assert.equal(sent.length, 0);
  assert.equal(state[27].text, "Incident summary");
  button(render(), "Сохранить аннотацию").props.onClick(); await waitDone();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.dashboardUID, "tech");
  assert.ok(state[28].startsWith("Аннотация сохранена"));
});

test("закрытый диалог не получает поздний статус сохранения аннотации", async () => {
  reset(); state[3] = [{ role: "assistant", content: "Incident summary" }];
  let resolve;
  global.fetch = () => new Promise(done => { resolve = done; });
  button(render(), "В аннотацию").props.onClick();
  button(render(), "Сохранить аннотацию").props.onClick(); await settle();
  button(render(), "Новый диалог").props.onClick();
  resolve(new Response('{"id":1}')); await settle(); await settle();
  assert.equal(state[27], undefined); assert.equal(state[28], ""); assert.equal(state[6], false);
});

test("командный SQL-сценарий использует существующее подтверждение расследования без скрытых запросов", () => {
  reset([], { customPrompts: [{ label: "Проверка заказов", prompt: "Проверь SQL заказов", needsPanel: true, investigation: true }] });
  state[1].panels = [{ id: 1, title: "Orders", datasource: { uid: "pg", type: "grafana-postgresql-datasource" }, targets: [{ refId: "A", rawSql: "SELECT 1" }] }]; state[15] = [1];
  let calls = 0; global.fetch = async () => { calls++; return response("unexpected"); };
  button(render(), "Проверка заказов").props.onClick(); assert.equal(calls, 0); assert.equal(state[13].action.prompt, "Проверь SQL заказов"); assert.equal(state[13].allowQueries, false);
});

test("UI плана не отправляет datasource до выбора; stop очищает ожидание без запроса", async () => {
  for (const stop of [false, true]) {
    reset([], { toolsMode: "text" });
    state[1].panels = [{ id: 1, title: "CPU", datasource: { uid: "prom", type: "prometheus" }, targets: [{ refId: "A", expr: "up" }] }]; state[15] = [1];
    state[1].timeRange = { from: Date.now() - 3600000, to: Date.now() };
    state[13] = { action: { prompt: "Investigate" }, allowQueries: true, approveToolPlans: true, collectPanelData: false, totalTimeoutSeconds: 45 };
    let posts = 0, queries = 0;
    global.fetch = async (url) => {
      if (String(url).includes("/api/ds/query")) { queries++; return new Response(JSON.stringify({ results: { AI: { frames: [] } } })); }
      return response(posts++ ? "Done" : '```grafana-query\n{"datasourceUid":"prom","query":{"expr":"up"},"reason":"check"}\n```');
    };
    button(render(), "Начать расследование").props.onClick();
    for (let i = 0; i < 100 && !nodes(render()).some(node => node.props["data-testid"] === "tech-ai-tool-plan"); i++) await settle();
    assert.ok(byId(render(), "tech-ai-tool-plan")); assert.equal(queries, 0);
    assert.equal(byId(render(), "tech-ai-tool-approve").props.disabled, true);
    if (stop) button(render(), "Остановить расследование").props.onClick();
    else {
      const plan = byId(render(), "tech-ai-tool-plan"); nodes(plan).find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
      byId(render(), "tech-ai-tool-approve").props.onClick();
    }
    await waitDone(); assert.equal(queries, stop ? 0 : 1);
    assert.equal(nodes(render()).some(node => node.props["data-testid"] === "tech-ai-tool-plan"), false);
  }
});

test("редактирование окна пика не запрашивает данные, неверное окно блокирует запуск", async () => {
  reset();
  const from = Date.parse("2026-10-14T09:00:00Z"), at = from + 1800000;
  state[1].timeRange = { from, to: from + 3600000 };
  const chart = { panelId: 1, title: "CPU", series: [{ name: "CPU", max: 80, maxAt: at, sampleIntervalMs: 60000 }] };
  state[3] = [{ role: "assistant", content: "CPU", charts: [chart] }];
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response("Answer"); };
  nodes(render()).find(node => node.props.onInvestigatePeak).props.onInvestigatePeak(chart, chart.series[0]);
  assert.equal(sent.length, 0);
  byId(render(), "tech-ai-peak-before").props.onChange({ target: { value: "" } });
  assert.equal(button(render(), "Начать расследование").props.disabled, true);
  byId(render(), "tech-ai-peak-before").props.onChange({ target: { value: "10" } });
  byId(render(), "tech-ai-peak-after").props.onChange({ target: { value: "2" } });
  assert.equal(sent.length, 0);
  button(render(), "Начать расследование").props.onClick(); await waitDone();
  assert.equal(sent.length, 1);
  const actual = JSON.parse(sent[0].messages[0].content.split("Текущий контекст Grafana:\n")[1]);
  assert.deepEqual(actual.timeRange, { from: at - 600000, to: at + 120000 });
});
