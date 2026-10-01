#!/usr/bin/env node
// Прогон эталонных вопросов через тот же код, что работает в плагине: сборка промпта, бюджет контекста,
// стриминг, текстовый протокол запросов. Без браузера и сборки, нужен только Node 18+.
//
// Напрямую к модели:
//   LLM_URL=http://ollama:11434 LLM_MODEL=qwen3:8b CONTEXT_TOKENS=8192 node evals/run.js
// Через Grafana с сохранёнными настройками плагина:
//   GRAFANA_URL=http://grafana:3000/crf/dashboard GRAFANA_USER=admin GRAFANA_PASSWORD=admin node evals/run.js
// Флаги: --case id1,id2  --repeat 3  --out evals/results/run.json
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = { repeat: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--case") args.cases = argv[++index].split(",").map((item) => item.trim());
    else if (key === "--repeat") args.repeat = Math.max(1, Number(argv[++index]) || 1);
    else if (key === "--out") args.out = argv[++index];
    else if (key === "--help" || key === "-h") args.help = true;
  }
  return args;
}

function loadPlugin(appSubUrl) {
  let factory;
  global.define = (_deps, fn) => { factory = fn; };
  require(path.join(__dirname, "../plugin/module.js"));
  delete global.define;
  class AppPlugin {
    constructor() {
      const proxy = new Proxy(this, { get: () => () => proxy });
      return proxy;
    }
  }
  const store = new Map();
  global.sessionStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  const grafanaRuntime = { config: { appSubUrl, bootData: { user: { orgId: 1, orgRole: "Admin" } } } };
  return factory({ AppPlugin, BusEventWithPayload: class {} }, grafanaRuntime, { createElement: () => null, Fragment: "Fragment" }, {}).__test;
}

async function setup() {
  const nativeFetch = global.fetch;
  if (process.env.GRAFANA_URL) {
    const base = process.env.GRAFANA_URL.replace(/\/$/, "");
    const auth = "Basic " + Buffer.from(`${process.env.GRAFANA_USER || "admin"}:${process.env.GRAFANA_PASSWORD || "admin"}`).toString("base64");
    global.fetch = (url, init) => nativeFetch(url, Object.assign({}, init, { headers: Object.assign({}, init && init.headers, { Authorization: auth }) }));
    const t = loadPlugin(new URL(base).pathname.replace(/\/$/, ""));
    const response = await nativeFetch(`${base}/api/plugins/tech-ai-assistant-app/settings`, { headers: { Authorization: auth } });
    if (!response.ok) throw new Error(`Не удалось прочитать настройки плагина: HTTP ${response.status}`);
    const saved = await response.json();
    const secure = saved.secureJsonFields || {};
    const settings = Object.assign({}, t.defaults, saved.jsonData || {}, { _hasApiKey: Boolean(secure.apiKey), _hasGroqApiKey: Boolean(secure.groqApiKey) });
    // Относительный URL плагина превращаем в абсолютный адрес Grafana.
    const origin = new URL(base).origin;
    const fetchWithOrigin = global.fetch;
    global.fetch = (url, init) => fetchWithOrigin(String(url).startsWith("/") ? origin + url : url, init);
    return { t, settings, target: `Grafana ${base}` };
  }
  if (!process.env.LLM_URL) throw new Error("Задайте LLM_URL (+ LLM_MODEL) или GRAFANA_URL. См. evals/README.md");
  const t = loadPlugin("");
  const endpoint = process.env.LLM_URL.replace(/\/$/, "") + (process.env.LLM_PATH || "/v1/chat/completions");
  global.fetch = (url, init) => {
    if (!String(url).includes("/api/plugin-proxy/")) return nativeFetch(url, init);
    const headers = Object.assign({}, init && init.headers);
    if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;
    return nativeFetch(endpoint, Object.assign({}, init, { headers }));
  };
  const settings = Object.assign({}, t.defaults, {
    provider: "custom",
    apiUrl: process.env.LLM_URL,
    apiPath: process.env.LLM_PATH || "/v1/chat/completions",
    model: process.env.LLM_MODEL || "",
    useAuth: false,
    contextTokens: Number(process.env.CONTEXT_TOKENS || 8192),
    maxTokens: Number(process.env.MAX_TOKENS || 0),
    reasoningEffort: process.env.REASONING_EFFORT || "",
    streaming: process.env.STREAM !== "0",
    toolsMode: process.env.TOOLS_MODE || "text",
  });
  if (process.env.SYSTEM_PROMPT_FILE) settings.systemPrompt = fs.readFileSync(process.env.SYSTEM_PROMPT_FILE, "utf8");
  return { t, settings, target: endpoint };
}

async function runCase(t, baseSettings, testCase, timeoutMs) {
  const settings = Object.assign({}, baseSettings, testCase.settings || {});
  const plan = t.planRequest(settings, testCase.context, [], testCase.prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let firstTokenMs;
  const output = { plan, steps: [], codeBlocks: [], content: "", reasoning: "" };
  try {
    const result = await t.runAssistant(settings, testCase.context, plan.contextJson, [{ role: "user", content: testCase.prompt }], {
      queries: Boolean(testCase.queries),
      signal: controller.signal,
      onUpdate: (update) => {
        if (firstTokenMs === undefined && (update.content || update.reasoning)) firstTokenMs = Date.now() - started;
      },
      executeQuery: async (_settings, _context, args) => {
        if (!testCase.respond) throw new Error("В этом кейсе запросы не предусмотрены");
        return testCase.respond(args || {});
      },
    });
    Object.assign(output, result);
  } catch (reason) {
    output.error = reason && reason.name === "AbortError" ? `Таймаут ${timeoutMs / 1000} с` : t.formatError(reason);
  } finally {
    clearTimeout(timer);
  }
  output.latencyMs = Date.now() - started;
  output.firstTokenMs = firstTokenMs;
  output.codeBlocks = t.splitContent(output.content).filter((part) => part.type === "code");
  output.proposal = t.parseDashboardProposal(output.content);
  const checks = testCase.checks.map((item) => {
    let pass = false;
    try {
      pass = Boolean(item.fn(output));
    } catch (_) {}
    return { name: item.name, pass };
  });
  return {
    id: testCase.id,
    category: testCase.category,
    passed: checks.every((item) => item.pass),
    score: checks.filter((item) => item.pass).length / checks.length,
    checks,
    latencyMs: output.latencyMs,
    firstTokenMs: output.firstTokenMs,
    promptTokens: plan.totalTokens,
    contextReductions: plan.reductions,
    queries: output.steps.length,
    error: output.error,
    content: output.content,
    reasoning: output.reasoning ? output.reasoning.slice(0, 4000) : undefined,
    steps: output.steps,
  };
}

function seconds(ms) {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}с`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 9).join("\n"));
    return;
  }
  const cases = require("./cases").filter((item) => !args.cases || args.cases.includes(item.id));
  if (!cases.length) throw new Error("Нет кейсов для запуска");
  const { t, settings, target } = await setup();
  const timeoutMs = Number(process.env.CASE_TIMEOUT_S || 300) * 1000;
  console.log(`Модель: ${settings.provider === "groq" ? settings.groqModel : settings.model} · ${target} · окно ${settings.contextTokens} · запросы: ${settings.toolsMode} · stream: ${settings.streaming !== false}`);
  const results = [];
  for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
    for (const testCase of cases) {
      const result = await runCase(t, settings, testCase, timeoutMs);
      result.attempt = attempt;
      results.push(result);
      const failed = result.checks.filter((item) => !item.pass).map((item) => item.name);
      console.log(`${result.passed ? "✓" : "✗"} ${testCase.id.padEnd(20)} ${String(result.checks.filter((c) => c.pass).length + "/" + result.checks.length).padEnd(5)} ${seconds(result.latencyMs).padStart(7)}  первый токен ${seconds(result.firstTokenMs)}${result.error ? `  ошибка: ${result.error}` : ""}${failed.length && !result.error ? `  не прошло: ${failed.join("; ")}` : ""}`);
    }
  }
  const passed = results.filter((item) => item.passed).length;
  const avg = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined);
  const summary = {
    model: settings.provider === "groq" ? settings.groqModel : settings.model,
    target,
    date: new Date().toISOString(),
    settings: { contextTokens: settings.contextTokens, toolsMode: settings.toolsMode, streaming: settings.streaming, maxTokens: settings.maxTokens, streamFellBack: t.isStreamUnsupported(settings) },
    casesPassed: passed,
    casesTotal: results.length,
    checkScore: avg(results.map((item) => item.score)),
    avgLatencyMs: avg(results.map((item) => item.latencyMs)),
    avgFirstTokenMs: avg(results.map((item) => item.firstTokenMs).filter((value) => value !== undefined)),
    byCategory: {},
  };
  results.forEach((item) => {
    const bucket = summary.byCategory[item.category] || (summary.byCategory[item.category] = { passed: 0, total: 0 });
    bucket.total += 1;
    if (item.passed) bucket.passed += 1;
  });
  console.log(`\nИтог: ${passed}/${results.length} кейсов, ${(summary.checkScore * 100).toFixed(0)}% проверок, среднее время ${seconds(summary.avgLatencyMs)}, первый токен ${seconds(summary.avgFirstTokenMs)}`);
  Object.keys(summary.byCategory).forEach((name) => console.log(`  ${name}: ${summary.byCategory[name].passed}/${summary.byCategory[name].total}`));
  const out = args.out || path.join(__dirname, "results", `${summary.date.slice(0, 19).replace(/[:T]/g, "-")}-${String(summary.model).replace(/[^\w.-]+/g, "_")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
  console.log(`Отчёт: ${out}`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(2);
});
