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
  const grafanaData = { AppPlugin, BusEventWithPayload: class {} };
  const grafanaRuntime = { config: { appSubUrl: "/crf/dashboard", bootData: { user: { orgId: 1, orgRole: "Admin" } } } };
  const React = { createElement: () => null, Fragment: "Fragment" };
  return factory(grafanaData, grafanaRuntime, React, {}).__test;
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
  const settings = { model: "m", streaming: true, toolsMode: "text", investigationDatasourceTypes: "loki,prometheus" };
  const text = t.requestBody(settings, "{}", [], { mode: "text" });
  assert.equal(text.tools, undefined);
  assert.match(text.messages[0].content, /grafana-query/);
  assert.equal(text.stream, true);
  const native = t.requestBody(settings, "{}", [], { mode: "native", last: true });
  assert.equal(native.tool_choice, "none");
  assert.equal(native.tools.length, 1);
});

test("пустой API key не добавляет auth-маршрут для custom provider", () => {
  assert.equal(t.proxyRoute({ provider: "custom", useAuth: true, _hasApiKey: false }), "chat");
  assert.equal(t.modelsRoute({ provider: "custom", useAuth: true, _hasApiKey: false }), "models");
  assert.equal(t.proxyRoute({ provider: "custom", useAuth: true, _hasApiKey: true }), "chat-auth");
});

test("exploreUrl учитывает appSubUrl и диапазон времени", () => {
  const url = t.exploreUrl({ timeRange: { from: "now-6h", to: "now" } }, { uid: "prom", type: "prometheus" }, { expr: "up" });
  assert.ok(url.startsWith("/crf/dashboard/explore?schemaVersion=1&orgId=1&panes="));
  const panes = JSON.parse(decodeURIComponent(url.split("panes=")[1]));
  assert.equal(panes.a.queries[0].expr, "up");
  assert.equal(panes.a.range.from, "now-6h");
});
