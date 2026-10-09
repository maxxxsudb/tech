// Unit-тесты чистых функций плагина без Grafana и браузера: node --test test/unit.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadModule() {
  let factory;
  global.define = (_deps, fn) => { factory = fn; };
  delete require.cache[require.resolve(path.join(__dirname, "../plugin/module.js"))];
  require(path.join(__dirname, "../plugin/module.js"));
  delete global.define;
  class AppPlugin {
    constructor() {
      const proxy = new Proxy(this, { get: () => () => proxy });
      return proxy;
    }
  }
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const dateMath = {
    parse: (value) => {
      if (value === "now") return { valueOf: () => NOW };
      const match = /^now-(\d+)([hd])$/.exec(value);
      return match ? { valueOf: () => NOW - Number(match[1]) * (match[2] === "h" ? 3600e3 : 86400e3) } : undefined;
    },
  };
  const grafanaData = { AppPlugin, BusEventWithPayload: class {}, dateMath };
  const grafanaRuntime = { config: { appSubUrl: "/crf/dashboard", bootData: { user: { orgId: 1, orgRole: "Admin" } } } };
  const React = { createElement: () => null, Fragment: "Fragment" };
  return factory(grafanaData, grafanaRuntime, React, {}, require("../plugin/attachments.js"), require("../plugin/conversation.js"), require("../plugin/query-tools.js")).__test;
}

const t = loadModule();

test("splitThink выносит размышления, в том числе незакрытый <think> при стриминге", () => {
  assert.deepEqual(t.splitThink("<think>считаю</think>\nОтвет"), { content: "Ответ", reasoning: "считаю" });
  assert.deepEqual(t.splitThink("<think>ещё думаю"), { content: "", reasoning: "ещё думаю" });
  assert.deepEqual(t.splitThink("Просто ответ"), { content: "Просто ответ", reasoning: "" });
});

function sseResponse(chunks, contentType) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": contentType || "text/event-stream" } });
}

test("readEventStream собирает content, reasoning и tool_calls из чанков, разрезанных посередине строки", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "думаю" } }] },
    { choices: [{ delta: { content: "При" } }] },
    { choices: [{ delta: { content: "вет" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "query_grafana_datasource", arguments: "{\"a\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
  ];
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const cut = Math.floor(text.length / 2);
  const updates = [];
  const acc = await t.readEventStream(sseResponse([text.slice(0, cut), text.slice(cut)]), (value) => updates.push(value.content));
  assert.equal(acc.content, "Привет");
  assert.equal(acc.reasoning, "думаю");
  assert.equal(acc.finishReason, "tool_calls");
  assert.deepEqual(acc.toolCalls, [{ id: "c1", type: "function", function: { name: "query_grafana_datasource", arguments: "{\"a\":1}" } }]);
  assert.ok(updates.length >= 2);
});

test("readEventStream принимает обычный JSON, если провайдер проигнорировал stream", async () => {
  const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const acc = await t.readEventStream(sseResponse([body], "text/plain"));
  assert.equal(acc.content, "ok");
});

test("readEventStream пробрасывает ошибку провайдера из потока", async () => {
  await assert.rejects(
    t.readEventStream(sseResponse([`data: ${JSON.stringify({ error: { message: "model not found" } })}\n\n`])),
    (reason) => t.formatError(reason).includes("model not found")
  );
});

test("parseTextToolCalls читает до трёх блоков grafana-query и отмечает битый JSON", () => {
  const content = [
    "```grafana-query\n{\"datasourceUid\":\"loki\",\"query\":{\"expr\":\"{a=\\\"b\\\"}\"},\"reason\":\"r\"}\n```",
    "```grafana-query\n{не json}\n```",
    "```grafana-query\n{}\n```",
    "```grafana-query\n{}\n```",
  ].join("\n");
  const calls = t.parseTextToolCalls(content);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args.datasourceUid, "loki");
  assert.ok(calls[1].error);
});

test("flattenPanels раскрывает свёрнутые rows и помнит заголовок строки", () => {
  const panels = [
    { id: 1, type: "timeseries" },
    { id: 10, type: "row", title: "Свёрнутая", panels: [{ id: 11, type: "stat" }] },
    { id: 20, type: "row", title: "Развёрнутая", panels: [] },
    { id: 21, type: "logs" },
  ];
  const flat = t.flattenPanels(panels).map((item) => [item.panel.id, item.row]);
  assert.deepEqual(flat, [[1, undefined], [11, "Свёрнутая"], [21, "Развёрнутая"]]);
});

test("fitContext уменьшает контекст по шагам и не режет JSON", () => {
  const context = {
    dashboardTitle: "Big",
    panels: Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      title: `Panel ${index + 1}`,
      fieldConfig: { defaults: { custom: { text: "x".repeat(400) } } },
      targets: [{ refId: "A", expr: `rate(http_requests_total{job="api",code=~"5.."}[5m]) ${"y".repeat(100)}` }],
    })),
  };
  const full = JSON.stringify(context).length;
  const fitted = t.fitContext(context, Math.floor(full / 4));
  assert.ok(fitted.json.length <= Math.floor(full / 4));
  assert.doesNotThrow(() => JSON.parse(fitted.json));
  assert.ok(fitted.reductions.includes("fieldConfig других панелей"));
  const untouched = t.fitContext(context, full + 10);
  assert.deepEqual(untouched.reductions, []);
});

test("planRequest урезает историю под окно модели и считает токены", () => {
  const settings = { systemPrompt: "s", contextTokens: 4000, maxTokens: 0, toolsMode: "text", investigationDatasourceTypes: "loki" };
  const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "z".repeat(600) }));
  const plan = t.planRequest(settings, { dashboardTitle: "d" }, history, "вопрос");
  assert.ok(plan.droppedMessages > 0);
  assert.equal(plan.droppedMessages % 2, 0);
  assert.ok(plan.totalTokens <= 4000);
});

test("splitContent разделяет текст и блоки кода", () => {
  const parts = t.splitContent("Текст\n```promql\nrate(x[5m])\n```\nещё");
  assert.deepEqual(parts.map((part) => part.type), ["text", "code", "text"]);
  assert.equal(parts[1].lang, "promql");
  assert.equal(parts[1].code, "rate(x[5m])");
});

test("parseDashboardProposal принимает только panelId и массив targets", () => {
  assert.deepEqual(t.parseDashboardProposal("```dashboard-json\n{\"panelId\": 2, \"targets\": []}\n```"), { panelId: 2, targets: [] });
  assert.equal(t.parseDashboardProposal("```dashboard-json\n{\"panelId\": 2}\n```"), undefined);
});

test("sanitizeForAI вычищает секреты", () => {
  const value = t.sanitizeForAI({ apiKey: "x", url: "http://h/?token=abc", header: "Bearer sk-abcdefghijklmnopqrst" });
  assert.equal(value.apiKey, "[REDACTED]");
  assert.equal(value.url, "http://h/?token=[REDACTED]");
  assert.equal(value.header, "Bearer [REDACTED]");
});

test("requestBody: текстовый протокол без tools, native — с tools и tool_choice none на последнем раунде", () => {
  const settings = { model: "m", streaming: true, toolsMode: "text", investigationDatasourceTypes: "loki,prometheus", contextDelivery: "inline" };
  const text = t.requestBody(settings, "{}", [], { mode: "text" });
  assert.equal(text.tools, undefined);
  assert.match(text.messages[0].content, /grafana-query/);
  assert.equal(text.stream, true);
  const native = t.requestBody(settings, "{}", [], { mode: "native", last: true });
  assert.equal(native.tool_choice, "none");
  assert.equal(native.tools.length, 1);
});

test("контекст передаётся inline или отдельным именованным JSON-документом", () => {
  const base = { model: "m", streaming: false, investigationDatasourceTypes: "loki" };
  const inline = t.requestBody(Object.assign({}, base, { contextDelivery: "inline" }), '{"dashboardUid":"d"}', [], {});
  assert.equal(inline.messages.length, 1);
  assert.match(inline.messages[0].content, /"dashboardUid":"d"/);

  const document = t.requestBody(Object.assign({}, base, { contextDelivery: "jsonDocument" }), '{"dashboardUid":"d"}', [{ role: "user", content: "вопрос" }], {});
  assert.equal(document.messages.length, 2);
  assert.match(document.messages[0].content, /grafana-context\.json/);
  assert.match(document.messages[1].content, /^вопрос\n\nФайл: grafana-context\.json/);
  assert.match(document.messages[1].content, /"dashboardUid":"d"/);
  assert.equal(t.resolveContextDelivery(Object.assign({}, base, { contextDelivery: "auto" })), "inline");
  assert.equal(t.defaults.contextTokens, 8192);
});

test("JSON-документ не создаёт два user-сообщения подряд и поддерживает снимок", () => {
  const messages = [
    { role: "user", content: "первый" },
    { role: "assistant", content: "ответ" },
    { role: "user", content: [{ type: "text", text: "второй" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,x" } }] },
  ];
  const attached = t.attachContextDocument(messages, "{}");
  assert.deepEqual(attached.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(attached[2].content.length, 3);
  assert.match(attached[2].content[2].text, /^Файл: grafana-context\.json/);
});

test("выбор панелей оставляет в контексте только отмеченные панели", () => {
  const context = { dashboardUid: "d", panels: [{ id: 1, title: "CPU" }, { id: 2, title: "Logs" }] };
  assert.deepEqual(t.availablePanels(context).map((panel) => panel.id), [1, 2]);
  assert.deepEqual(t.selectContextPanels(context, [2]).panels, [{ id: 2, title: "Logs" }]);
  assert.deepEqual(t.selectContextPanels(context, []).panels, []);

  const selected = { dashboardUid: "d", panel: { id: 7, title: "Latency" } };
  assert.equal(t.selectContextPanels(selected, [7]).panel.id, 7);
  assert.equal(t.selectContextPanels(selected, []).panel, undefined);
});

test("пустой API key не добавляет auth-маршрут для custom provider", () => {
  assert.equal(t.proxyRoute({ provider: "custom", useAuth: true, _hasApiKey: false }), "chat");
  assert.equal(t.modelsRoute({ provider: "custom", useAuth: true, _hasApiKey: false }), "models");
  assert.equal(t.proxyRoute({ provider: "custom", useAuth: true, _hasApiKey: true }), "chat-auth");
});

test("безопасный профиль по умолчанию выключает streaming", () => {
  assert.equal(t.defaults.streaming, false);
  const body = t.requestBody(t.defaults, "{}", [{ role: "user", content: "test" }], {});
  assert.equal(body.stream, false);
});

test("диагностика не включает identity без явного разрешения", () => {
  const ordinary = t.diagnosticPayload(t.defaults, { totalTokens: 100 }, "boom", false);
  const allowed = t.diagnosticPayload(t.defaults, { totalTokens: 100 }, "boom", true);
  assert.equal(ordinary.identity, undefined);
  assert.equal(allowed.identity.orgId, 1);
  assert.equal(ordinary.request.contextJson, undefined);
});

test("профили не меняют provider, модель и API URL", () => {
  for (const profile of Object.values(t.configurationProfiles)) {
    assert.equal(profile.provider, undefined);
    assert.equal(profile.model, undefined);
    assert.equal(profile.apiUrl, undefined);
    assert.equal(profile.streaming, false);
  }
  assert.equal(t.configurationProfiles.safe.includePanelData, false);
  assert.equal(t.configurationProfiles.normal.explainSampleRows, 3);
  assert.equal(t.configurationProfiles.deep.contextTokens, 32768);
});

test("ошибка прокси сохраняет детали API и даёт подсказку для 502", () => {
  assert.match(t.formatError({ status: 400, data: { error: { type: "invalid_request_error", param: "messages[1].content", message: "image_url is not supported" } } }), /image_url is not supported/);
  assert.match(t.formatError({ status: 502, data: { message: "Bad Gateway" } }), /GF_DATAPROXY_TIMEOUT=300/);
});

test("ошибка снимка показывает параметры отправленного JPEG без скрытого fallback", () => {
  const note = t.screenshotErrorNote({ width: 1200, height: 700, bytes: 102401 }, { status: 400 });
  assert.match(note, /JPEG 1200×700, 101 КБ/);
  assert.match(note, /до генерации ответа моделью/);
});

test("расследование по умолчанию не форсирует дополнительные datasource-запросы", () => {
  const action = t.quickPrompts.find((item) => item.label === "Расследовать");
  assert.equal(action.queries, undefined);
  assert.match(action.prompt, /Если дополнительные запросы не разрешены/);
});

test("vision-тест формирует пять JSON-схем из одного JPEG", () => {
  const dataUrl = "data:image/jpeg;base64,QUJD";
  const cases = t.imageTestCases(dataUrl);
  assert.equal(cases.length, 5);
  assert.deepEqual(cases.map((item) => item.id), Object.keys(t.imageTransportLabels));
  assert.equal(cases.find((item) => item.id === "ollamaImages").message.images[0], "QUJD");
  assert.equal(cases.find((item) => item.id === "openaiDataUri").message.content[1].image_url.url, dataUrl);
  assert.equal(cases.find((item) => item.id === "anthropicBase64").message.content[1].source.data, "QUJD");
});

test("drawer ограничивает длинный ответ шириной viewport", () => {
  assert.equal(t.styles.root.minWidth, 0);
  assert.equal(t.styles.history.overflowX, "hidden");
  assert.equal(t.styles.history.overflowY, "auto");
  assert.equal(t.styles.tabBody.overflowY, "auto");
  assert.equal(t.styles.tabBody.minHeight, 0);
  assert.equal(t.styles.notices.overflowY, "auto");
  assert.equal(t.styles.notices.minHeight, 0);
  assert.equal(t.styles.user.flexShrink, 0);
  assert.equal(t.styles.assistant.flexShrink, 0);
  assert.match(t.drawerScopedCss, /tech-ai-history\\?"\] > \* \{ flex-shrink: 0; \}/);
  assert.equal(t.styles.assistant.maxWidth, "100%");
  assert.equal(t.styles.pre.maxWidth, "100%");
  assert.match(t.drawerScopedCss, /markdown-html table/);
  assert.match(t.drawerScopedCss, /overflow-x: auto/);
});

test("неподдерживаемый stream автоматически повторяется без streaming", () => {
  assert.equal(t.shouldRetryWithoutStream({ stream: true }, 400, {}), true);
  assert.equal(t.shouldRetryWithoutStream({ stream: true }, 422, {}), true);
  assert.equal(t.shouldRetryWithoutStream({ stream: false }, 400, {}), false);
  assert.equal(t.shouldRetryWithoutStream({ stream: true }, 400, { noStreamFallback: true }), false);
  assert.equal(t.shouldRetryWithoutStream({ stream: true }, 401, {}), false);
});

test("exploreUrl учитывает appSubUrl и диапазон времени", () => {
  const url = t.exploreUrl({ timeRange: { from: "now-6h", to: "now" } }, { uid: "prom", type: "prometheus" }, { expr: "up" });
  assert.ok(url.startsWith("/crf/dashboard/explore?schemaVersion=1&orgId=1&panes="));
  const panes = JSON.parse(decodeURIComponent(url.split("panes=")[1]));
  assert.equal(panes.a.queries[0].expr, "up");
  assert.equal(panes.a.range.from, "now-6h");
});

test("limitedRange сокращает диапазон запросов AI от конца диапазона", () => {
  const clamped = t.limitedRange({ timeRange: { from: "now-30d", to: "now" } }, 24);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.to - clamped.from, 24 * 3600e3);
  const untouched = t.limitedRange({ timeRange: { from: "now-6h", to: "now" } }, 24);
  assert.equal(untouched.clamped, false);
  assert.equal(untouched.to - untouched.from, 6 * 3600e3);
  assert.equal(t.limitedRange({ timeRange: { from: "now-30d", to: "now" } }, 0).clamped, false);
});

test("жёсткие лимиты запросов нельзя увеличить настройками модели", () => {
  assert.equal(t.positiveInt(1000, 200, 200), 200);
  assert.equal(t.positiveInt(100, 20, 20), 20);
  assert.equal(t.positiveInt(0, 6, 20), 6);
  assert.equal(t.positiveInt(-10, 6, 20), 6);
  assert.equal(t.positiveInt(2.9, 6, 20), 2);
});

test("остановка пользователя прерывает запрос к datasource", async () => {
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await withBrowserGlobals(fetchImpl, async () => {
    const controller = new AbortController();
    const pending = t.runDatasourceQueries({ timeRange: { from: "now-1h", to: "now" } }, [], { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (reason) => reason && reason.name === "AbortError");
  });
});

function withBrowserGlobals(fetchImpl, fn) {
  const store = new Map();
  const previous = { fetch: global.fetch, sessionStorage: global.sessionStorage };
  global.sessionStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  global.fetch = fetchImpl;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = previous.fetch;
    global.sessionStorage = previous.sessionStorage;
  });
}

test("после отказа в stream флаг на сессию отключает stream для следующих запросов", async () => {
  const streams = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    streams.push(body.stream);
    if (body.stream) return new Response(JSON.stringify({ error: { message: "stream is not supported" } }), { status: 422, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
  };
  await withBrowserGlobals(fetchImpl, async () => {
    const settings = { provider: "custom", apiUrl: "http://llm", apiPath: "/v1/chat/completions", model: "m", useAuth: false };
    assert.equal((await t.postChat(settings, { model: "m", stream: true, messages: [] })).content, "ok");
    assert.equal(t.isStreamUnsupported(settings), true);
    assert.equal((await t.postChat(settings, { model: "m", stream: true, messages: [] })).content, "ok");
    assert.equal(t.isStreamUnsupported(Object.assign({}, settings, { model: "other" })), false);
  });
  assert.deepEqual(streams, [true, false, false]);
});

test("ошибка не из-за stream не ставит флаг", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "context too long" } }), { status: 400, headers: { "content-type": "application/json" } });
  await withBrowserGlobals(fetchImpl, async () => {
    const settings = { provider: "custom", apiUrl: "http://llm", apiPath: "/v1/chat/completions", model: "m", useAuth: false };
    await assert.rejects(t.postChat(settings, { model: "m", stream: true, messages: [] }));
    assert.equal(t.isStreamUnsupported(settings), false);
  });
});

test("runAssistant соблюдает лимит запросов AI за один ответ и просит итог", async () => {
  const settings = Object.assign({}, t.defaults, { toolsMode: "text", aiQueryMaxPerTurn: 2 });
  const block = (n) => "```grafana-query\n" + JSON.stringify({ datasourceUid: "loki", query: { expr: `q${n}` }, reason: `r${n}` }) + "\n```";
  const requests = [];
  let executed = 0;
  const result = await t.runAssistant(settings, {}, "{}", [{ role: "user", content: "расследуй" }], {
    queries: true,
    post: async (_settings, body) => {
      requests.push(body);
      const content = requests.length === 1 ? block(1) + block(2) + block(3) : "Итог";
      return { content, reasoning: "", toolCalls: [], usage: { prompt: 10, completion: 2 } };
    },
    executeQuery: async () => {
      executed += 1;
      return { results: [] };
    },
  });
  assert.equal(executed, 2);
  assert.equal(result.content, "Итог");
  assert.equal(result.steps.filter((step) => step.error).length, 1);
  assert.match(requests[1].messages[requests[1].messages.length - 1].content, /Лимит запросов исчерпан/);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.usage, { prompt: 20, completion: 4 });
});

test("оценка расследования заранее считает нагрузку и ограничивает диапазон", () => {
  const context = {
    timeRange: { from: "now-7d", to: "now" },
    panels: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      datasource: { type: "prometheus", uid: "prom" },
      targets: [{ expr: "up" }, { expr: "rate(x[5m])" }, { expr: "sum(y)" }],
    })),
  };
  const estimate = t.investigationEstimate(t.defaults, context, { rangeHours: 6, maxPanels: 3, maxTargets: 2 });
  assert.equal(estimate.datasourceRequests, 3);
  assert.equal(estimate.targetQueries, 6);
  assert.equal(estimate.to - estimate.from, 6 * 3600e3);
  assert.equal(estimate.clamped, true);
});

test("fitContext при сильном сжатии сохраняет названия всех панелей, а не только первых 60", () => {
  const context = { panels: Array.from({ length: 80 }, (_, index) => ({ id: index + 1, title: `Panel ${index + 1}`, type: "timeseries", datasource: { type: "prometheus", uid: "prom" }, targets: [{ refId: "A", expr: "x".repeat(200) }] })) };
  const fitted = t.fitContext(context, 4000);
  assert.ok(fitted.json.includes("Panel 80"));
  assert.ok(fitted.reductions.includes("панели только с id и названием"));
  assert.ok(!fitted.reductions.includes("панели сверх 60"));
});

test("joinEndpoint убирает повтор /v1 между API URL и путём и не трогает свои пути", () => {
  assert.equal(t.joinEndpoint("http://host/llm/v1", "/v1/chat/completions").url, "http://host/llm/v1/chat/completions");
  assert.equal(t.joinEndpoint("http://host/llm/v1/", "/v1/models").path, "/models");
  assert.equal(t.joinEndpoint("https://g.com/v1beta/openai", "/v1beta/openai/chat/completions").path, "/chat/completions");
  assert.equal(t.joinEndpoint("http://ollama:11434", "/v1/chat/completions").url, "http://ollama:11434/v1/chat/completions");
  assert.equal(t.joinEndpoint("http://host/llm", "llm/generate").url, "http://host/llm/llm/generate");
  assert.equal(t.joinEndpoint("http://host/v1", "/v1").path, "/v1");
  assert.throws(() => t.joinEndpoint("http://host", "/../x"));
});

function rawSeries(labels, values, start) {
  const times = values.map((_, index) => (start || Date.parse("2026-10-05T10:00:00Z")) + index * 60000);
  return { schema: { refId: "A", fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels }] }, data: { values: [times, values] } };
}

test("summarizeQueryResult отдаёт сводку серии с пиком и последними точками, а не первые строки", () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 97 ? 50 : 1));
  const summary = t.summarizeQueryResult({ status: 200, frames: [rawSeries({ pod: "api-1" }, values)] }, { rows: 20, recent: 3, series: 10 });
  const series = summary.series[0];
  assert.equal(series.name, "pod=api-1");
  assert.equal(series.max, 50);
  assert.equal(series.maxAt, "10-05 11:37");
  assert.equal(series.last, 1);
  assert.deepEqual(series.recent.map((point) => point[1]), [50, 1, 1]);
  assert.equal(summary.dataRange.to, "2026-10-05T11:39Z");
});

test("summarizeQueryResult оставляет серии с наибольшим max и пишет, сколько отброшено", () => {
  const frames = Array.from({ length: 12 }, (_, index) => rawSeries({ pod: `p${index}` }, [index, index * 2]));
  const summary = t.summarizeQueryResult({ status: 200, frames }, { rows: 5, recent: 0, series: 3 });
  assert.deepEqual(summary.series.map((item) => item.name), ["pod=p11", "pod=p10", "pod=p9"]);
  assert.match(summary.seriesNote, /3 серий .* из 12/);
});

test("summarizeQueryResult для логов отдаёт самые свежие строки, для таблиц — строки массивами", () => {
  const logs = { schema: { fields: [{ name: "Time", type: "time" }, { name: "Line", type: "string" }] }, data: { values: [[1, 3, 2], ["old", "newest", "mid"]] } };
  const table = { schema: { fields: [{ name: "name", type: "string" }, { name: "logins", type: "number" }] }, data: { values: [["alice", "bob"], [42, 17]] } };
  const summary = t.summarizeQueryResult({ status: 200, frames: [logs, table] }, { rows: 2, recent: 0, series: 5 });
  assert.deepEqual(summary.tables[0].rows.map((row) => row[1]), ["newest", "mid"]);
  assert.deepEqual(summary.tables[1].rows, [["alice", 42], ["bob", 17]]);
  assert.equal(t.summarizeQueryResult({ status: 200, frames: [] }).empty, true);
});

test("apiHistory не отправляет вопрос без ответа и склеивает сообщения подряд с одной ролью", () => {
  const history = [
    { role: "user", content: "первый", failed: true },
    { role: "user", content: "второй" },
    { role: "assistant", content: "ответ" },
    { role: "assistant", content: "✅ применено", local: true },
    { role: "user", content: "третий" },
    { role: "user", content: "четвёртый" },
    { role: "assistant", content: "ответ 2" },
    { role: "user", content: "висящий" },
  ];
  assert.deepEqual(t.apiHistory(history).map((item) => `${item.role}:${item.content}`), ["user:второй", "assistant:ответ", "user:третий\n\nчетвёртый", "assistant:ответ 2"]);
});

test("loadPanelData запрашивает все выбранные панели в пределах maxDataPanels и честно помечает остальные", async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.queries.length);
    const results = {};
    body.queries.forEach((query) => { results[query.refId] = { status: 200, frames: [rawSeries({}, [1, 2])] }; });
    return { ok: true, status: 200, text: async () => JSON.stringify({ results }) };
  };
  try {
    const panels = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, title: `P${index + 1}`, datasource: { type: "prometheus", uid: "prom" }, targets: Array.from({ length: 3 }, (__, ref) => ({ refId: "ABC"[ref], expr: "up" })) }));
    panels.push({ id: 99, title: "Текст", type: "text" });
    const data = await t.loadPanelData(Object.assign({}, t.defaults, { maxDataPanels: 5, maxTargetsPerPanel: 2 }), { timeRange: { from: "now-1h", to: "now" }, panels });
    const stats = t.panelDataStats(data);
    assert.deepEqual(stats, { total: 7, loaded: 5, errors: 0, skipped: 2 });
    assert.deepEqual(calls, [2, 2, 2, 2, 2]);
    assert.match(data[0].note, /ещё 1 пропущено/);
    assert.match(data[6].skipped, /лимит 5 панелей/);
  } finally {
    global.fetch = original;
  }
});

test("loadPanelData имеет общий таймаут и сообщает прогресс", async () => {
  const progress = [];
  const original = global.fetch;
  global.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new DOMException("Aborted", "AbortError"));
    else init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  try {
    const panels = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, title: `P${index + 1}`, datasource: { type: "prometheus", uid: "prom" }, targets: [{ refId: "A", expr: "up" }] }));
    const data = await t.loadPanelData(t.defaults, { timeRange: { from: "now-1h", to: "now" }, panels }, {
      totalTimeoutSeconds: 1,
      onProgress: (value) => progress.push(value),
    });
    assert.equal(data.length, 5);
    assert.ok(data.every((item) => /Общий таймаут/.test(item.error)));
    assert.deepEqual(progress[0], { completed: 0, total: 5 });
    assert.deepEqual(progress.at(-1), { completed: 5, total: 5 });
  } finally {
    global.fetch = original;
  }
});

test("planRequest с готовым контекстом снимка не меняет contextJson на уточнениях", () => {
  const settings = Object.assign({}, t.defaults, { contextTokens: 8192 });
  const context = { dashboardTitle: "D", panels: [{ id: 1, title: "A" }] };
  const first = t.planRequest(settings, context, [], "вопрос");
  const history = [{ role: "user", content: "вопрос" }, { role: "assistant", content: "x".repeat(3000) }];
  const second = t.planRequest(settings, context, history, "уточнение", { fitted: first.fitted });
  assert.equal(second.contextJson, first.contextJson);
  assert.equal(second.messages.length, 2);
});

test("stripPendingQueries прячет блоки grafana-query, в том числе недописанный", () => {
  assert.equal(t.stripPendingQueries("Проверю.\n```grafana-query\n{\"datasourceUid\""), "Проверю.\n\n🔎 Готовлю запрос к datasource…");
  assert.equal(t.stripPendingQueries("Обычный ответ"), "Обычный ответ");
});

test("профиль задаёт все поля, которые меняет любой профиль: «Обычный» сбрасывает лимиты «Глубокого»", () => {
  const normal = t.profileValues("normal");
  assert.equal(normal.maxDataPanels, t.defaults.maxDataPanels);
  assert.equal(normal.maxPanelRows, t.defaults.maxPanelRows);
  assert.equal(normal.aiQueryTimeoutSeconds, t.defaults.aiQueryTimeoutSeconds);
  assert.equal(normal.label, undefined);
  assert.equal(normal.provider, undefined);
  assert.equal(t.profileValues("deep").maxDataPanels, 20);
});

test("калибровка оценки токенов по usage сохраняется для модели и меняет оценку", () => {
  const store = new Map();
  global.localStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  try {
    const settings = Object.assign({}, t.defaults, { model: "qwen3:8b" });
    assert.equal(t.loadCalibration(settings), 2);
    const before = t.planRequest(settings, { note: "x".repeat(3000) }, [], "q").totalTokens;
    assert.equal(t.recordCalibration(settings, { chars: 12000, prompt: 3000 }), 3.6);
    assert.equal(t.recordCalibration(settings, { chars: 100, prompt: 3000 }), 3.6, "маленький запрос не калибрует");
    assert.equal(t.loadCalibration(Object.assign({}, settings, { model: "other" })), 2);
    assert.equal(t.loadCalibration(settings), 3.6);
    assert.ok(t.planRequest(settings, { note: "x".repeat(3000) }, [], "q").totalTokens < before);
  } finally {
    t.loadCalibration(Object.assign({}, t.defaults, { model: "none" }));
    delete global.localStorage;
  }
});

test("пример для «Объяснить» ограничивает строки, но не число точек запроса", async () => {
  const sent = [];
  const original = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(...body.queries);
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: { A: { status: 200, frames: [rawSeries({}, Array.from({ length: 60 }, (_, i) => i))] } } }) };
  };
  try {
    const panel = { id: 1, title: "P", datasource: { type: "prometheus", uid: "prom" }, targets: [{ refId: "A", expr: "up" }] };
    const data = await t.loadPanelData(t.defaults, { timeRange: { from: "now-1h", to: "now" }, panel }, { sampleRows: 3, maxPanels: 1, maxTargets: 1, rangeHours: 1 });
    assert.equal(sent[0].maxDataPoints, 100);
    const series = data[0].results[0].result.series[0];
    assert.equal(series.max, 59);
    assert.equal(series.recent.length, 3);
  } finally {
    global.fetch = original;
  }
});

test("выбор панелей переживает пересоздание drawer", () => {
  const store = {};
  global.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const context = { panels: [{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 3, title: "c" }] };
  assert.deepEqual(t.loadPanelSelection("k", context), [1, 2, 3]);
  t.savePanelSelection("k", [2]);
  assert.deepEqual(t.loadPanelSelection("k", context), [2]);
  t.savePanelSelection("k", []);
  assert.deepEqual(t.loadPanelSelection("k", context), []);
  t.savePanelSelection("k", [99]);
  assert.deepEqual(t.loadPanelSelection("k", context), [1, 2, 3]);
  delete global.sessionStorage;
});

test("вложения включены по умолчанию и выключаются профилем «Безопасный»", () => {
  assert.equal(t.defaults.fileUploadsEnabled, true);
  assert.equal(t.profileValues("safe").fileUploadsEnabled, false);
  assert.equal(t.profileValues("normal").fileUploadsEnabled, true);
});

test("распознавание изображений выключено по умолчанию и во всех профилях", () => {
  assert.equal(t.defaults.imageToTextEnabled, false);
  for (const profile of Object.keys(t.configurationProfiles)) assert.equal(t.profileValues(profile).imageToTextEnabled, false);
});

test("Markdown fallback оформляет заголовки, списки и таблицу без дополнительной библиотеки", () => {
  const html = t.markdownHtml("## Итог\n\n**CPU**: высокий\n\n- Проверить\n- Сравнить\n\n| Панель | Значение |\n| --- | --- |\n| CPU | 95% |");
  assert.match(html, /<h2>Итог<\/h2>/);
  assert.match(html, /<strong>CPU<\/strong>/);
  assert.match(html, /<ul><li>Проверить<\/li><li>Сравнить<\/li><\/ul>/);
  assert.match(html, /<table>[\s\S]*<th>Панель<\/th>[\s\S]*<td>95%<\/td>/);
});

test("Markdown fallback не исполняет HTML и сохраняет содержимое inline code", () => {
  const html = t.fallbackMarkdown('<script>alert(1)</script>\n\n`**literal** <tag>`\n\n[x](javascript:alert)');
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<a "));
  assert.match(html, /<code>\*\*literal\*\* &lt;tag&gt;<\/code>/);
});

test("компактный контекст отражает только выбранные панели и настоящий снимок", () => {
  const context = { panels: [{ id: 1, title: "CPU" }, { id: 2, title: "RAM" }], timeRange: { from: "now-1h", to: "now" } };
  assert.deepEqual(t.contextSummary(context, [2]), { scope: "Панель: RAM", period: "Последний час", mode: "Без данных" });
  const summary = t.contextSummary(context, [1, 2], { stats: { loaded: 1, total: 2 }, range: { from: 1000, to: 2000 } });
  assert.equal(summary.scope, "Панели: 2");
  assert.equal(summary.mode, "Данные: 1/2");
  assert.equal(t.contextSummary(context, [2], undefined, { dataMode: "sample" }).mode, "Короткий пример");
});

test("ошибки API получают короткое понятное объяснение без потери технического текста", () => {
  assert.equal(t.errorPresentation("HTTP 400 · base64 is not allowed").title, "API не принял запрос");
  assert.equal(t.errorPresentation("HTTP 502 · Bad gateway").title, "API не ответил");
  assert.equal(t.errorPresentation("HTTP 429 · quota exceeded").title, "Достигнут лимит API");
  assert.equal(t.errorPresentation("Запрос остановлен").title, "Запрос остановлен");
});

test("названия панелей в ответе становятся ссылками, код и ссылки не трогаются", () => {
  const { linkPanelTitles } = loadModule();
  const panels = [{ id: 2, title: "HTTP 5xx", type: "timeseries" }, { id: 3, title: "CPU", type: "stat" }, { id: 9, title: "Ряд", type: "row" }, { id: 4, title: "Дубль", type: "stat" }, { id: 5, title: "Дубль", type: "stat" }];
  const html = linkPanelTitles('<p>Рост на HTTP 5xx и на панели 3, а CPUs и cpu не панели. Дубль, панель 77.</p><pre><code>HTTP 5xx</code></pre><a href="x">CPU</a>', panels);
  assert.match(html, /<a href="#" class="tech-ai-panel-link" data-panel-id="2"[^>]*>HTTP 5xx<\/a> и на <a[^>]*data-panel-id="3"[^>]*>панели 3<\/a>/);
  assert.ok(!/>CPUs</.test(html) && html.includes("а CPUs и cpu"));
  assert.ok(html.includes("<code>HTTP 5xx</code>") && html.includes('<a href="x">CPU</a>'));
  assert.ok(html.includes("Дубль, панель 77."), "неоднозначное название и неизвестный номер не связываются");
  assert.equal(linkPanelTitles("<p>текст</p>", []), "<p>текст</p>");
});
