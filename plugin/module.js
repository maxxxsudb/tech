define(["@grafana/data", "@grafana/runtime", "react", "react-dom"], function (grafanaData, grafanaRuntime, React, ReactDOM) {
  "use strict";

  const PLUGIN_ID = "tech-ai-assistant-app";
  const COMPONENT_TITLE = "Tech AI Assistant";
  const SIDEBAR_TARGET = "grafana/extension-sidebar/v0-alpha";
  const PANEL_MENU_TARGET = "grafana/dashboard/panel/menu";
  const COMMAND_PALETTE_TARGET = "grafana/commandpalette/action";
  const EXPLORE_TOOLBAR_TARGET = "grafana/explore/toolbar/action";
  const CONTEXT_MARKER = "\n\nТекущий контекст Grafana:\n";
  const CHARS_PER_TOKEN = 3;
  const MAX_TOOL_ROUNDS = 4;
  const HISTORY_LIMIT = 40;
  const h = React.createElement;
  const defaults = {
    provider: "custom",
    apiUrl: "https://api.openai.com",
    apiPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    model: "gpt-4.1-mini",
    groqModel: "qwen/qwen3.8-27b",
    useAuth: true,
    authScheme: "Bearer",
    reasoningEffort: "",
    maxTokens: 0,
    contextTokens: 16000,
    streaming: true,
    toolsMode: "text",
    investigationDatasourceTypes: "loki,prometheus,tempo",
    launcherMode: "both",
    includePanelData: true,
    maxPanelRows: 20,
    allowedDatasourceUids: "",
    minimumRole: "Viewer",
    systemPrompt:
      "Ты AI-ассистент внутри Grafana. Помогай с дашбордами, PromQL, LogQL, SQL, алертами и observability. Отвечай на языке пользователя. Формулу, которую можно вставить в Grafana, показывай первой.",
  };
  // Шаблоны заполняют поля конфигурации; адрес указывается так, как его видит сервер Grafana.
  const providerPresets = {
    ollama: { label: "Ollama", provider: "custom", apiUrl: "http://ollama:11434", apiPath: "/v1/chat/completions", modelsPath: "/v1/models", useAuth: false, model: "qwen3:8b", contextTokens: 8192 },
    lmstudio: { label: "LM Studio", provider: "custom", apiUrl: "http://lmstudio:1234", apiPath: "/v1/chat/completions", modelsPath: "/v1/models", useAuth: false, model: "", contextTokens: 8192 },
    vllm: { label: "vLLM", provider: "custom", apiUrl: "http://vllm:8000", apiPath: "/v1/chat/completions", modelsPath: "/v1/models", useAuth: false, model: "", contextTokens: 32768 },
    llamacpp: { label: "llama.cpp server", provider: "custom", apiUrl: "http://llama-cpp:8080", apiPath: "/v1/chat/completions", modelsPath: "/v1/models", useAuth: false, model: "", contextTokens: 8192 },
    openai: { label: "OpenAI", provider: "custom", apiUrl: "https://api.openai.com", apiPath: "/v1/chat/completions", modelsPath: "/v1/models", useAuth: true, authScheme: "Bearer", model: "gpt-4.1-mini", contextTokens: 128000 },
    gemini: { label: "Gemini (OpenAI-compatible)", provider: "custom", apiUrl: "https://generativelanguage.googleapis.com", apiPath: "/v1beta/openai/chat/completions", modelsPath: "/v1beta/openai/models", useAuth: true, authScheme: "Bearer", model: "gemini-2.5-flash", contextTokens: 128000 },
    groq: { label: "Groq Free", provider: "groq", contextTokens: 32768 },
  };
  let cachedSettings = defaults;

  function configuredLauncherMode() {
    return localStorage.getItem("tech-ai-launcher-mode") || cachedSettings.launcherMode || "both";
  }

  function themeColors() {
    const theme = grafanaRuntime.config && grafanaRuntime.config.theme2;
    const colors = theme && theme.colors;
    const isLight = Boolean(theme && theme.isLight);
    return {
      background: (colors && colors.background && colors.background.primary) || (isLight ? "#ffffff" : "#111217"),
      border: (colors && colors.border && colors.border.medium) || (isLight ? "#d8d9dd" : "#34373d"),
      text: (colors && colors.text && colors.text.primary) || (isLight ? "#24292e" : "#f4f5f5"),
    };
  }

  const styles = {
    root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 10 },
    header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
    history: { flex: 1, minHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 8 },
    user: { alignSelf: "flex-end", maxWidth: "90%", padding: "8px 12px", borderRadius: 6, background: "#1f60c4", color: "white", whiteSpace: "pre-wrap" },
    assistant: { alignSelf: "stretch", padding: "8px 12px", borderRadius: 6, background: "rgba(128,128,128,.12)", overflowWrap: "anywhere" },
    markdown: { lineHeight: 1.5 },
    context: { color: "var(--text-secondary, #999)", fontSize: 12 },
    attachment: { color: "var(--text-secondary, #999)", fontSize: 12, marginTop: 4 },
    error: { padding: 10, border: "1px solid #e02f44", borderRadius: 4, color: "#e02f44", whiteSpace: "pre-wrap" },
    composer: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" },
    textarea: { width: "100%", minHeight: 72, resize: "vertical", padding: 8, color: "inherit", background: "transparent", border: "1px solid rgba(128,128,128,.45)", borderRadius: 4 },
    button: { minHeight: 32, padding: "0 12px", cursor: "pointer", borderRadius: 4, border: "1px solid rgba(128,128,128,.45)", background: "rgba(128,128,128,.16)", color: "inherit" },
    smallButton: { minHeight: 24, padding: "0 8px", cursor: "pointer", borderRadius: 4, border: "1px solid rgba(128,128,128,.45)", background: "rgba(128,128,128,.16)", color: "inherit", fontSize: 12 },
    stopButton: { minHeight: 32, padding: "0 12px", cursor: "pointer", borderRadius: 4, border: "1px solid #e02f44", background: "transparent", color: "#e02f44" },
    quickActions: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 },
    options: { display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 6 },
    proposal: { padding: 10, border: "1px solid #5794f2", borderRadius: 4, display: "grid", gap: 8 },
    step: { padding: "6px 8px", borderLeft: "3px solid #5794f2", fontSize: 12, display: "grid", gap: 4 },
    codeBlock: { display: "grid", gap: 4, margin: "6px 0" },
    diff: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
    pre: { maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11, padding: 8, margin: 0, background: "rgba(0,0,0,.25)" },
    config: { display: "grid", gap: 16, maxWidth: 760, padding: 16 },
    field: { display: "grid", gap: 6 },
    input: { width: "100%", minHeight: 36, padding: "6px 8px" },
  };

  function normalizePath(path) {
    const value = String(path || defaults.apiPath).trim();
    if (value.includes("..")) throw new Error("API path не должен содержать '..'");
    return value.startsWith("/") ? value : `/${value}`;
  }

  function formatError(reason) {
    if (reason && reason.name === "AbortError") return "Запрос остановлен";
    const rawData = reason && reason.data;
    const data = Array.isArray(rawData) ? rawData[0] : rawData;
    const apiError = data && data.error;
    const status = reason && (reason.status || reason.statusCode);
    const code = apiError && apiError.code;
    const message =
      (apiError && apiError.message) ||
      (typeof apiError === "string" ? apiError : "") ||
      (data && data.message) ||
      (reason && reason.message) ||
      (typeof reason === "string" ? reason : "Неизвестная ошибка");
    return [status ? `HTTP ${status}` : "", code || "", message].filter(Boolean).join(" · ");
  }

  async function getSettings() {
    const result = await grafanaRuntime.getBackendSrv().get(`/api/plugins/${PLUGIN_ID}/settings`);
    const secureJsonFields = result.secureJsonFields || {};
    return {
      jsonData: Object.assign({}, defaults, result.jsonData || {}, {
        _hasApiKey: Boolean(secureJsonFields.apiKey),
        _hasGroqApiKey: Boolean(secureJsonFields.groqApiKey),
      }),
      savedJsonData: result.jsonData || {},
      secureJsonFields,
    };
  }

  function appSubUrl() {
    return (grafanaRuntime.config && grafanaRuntime.config.appSubUrl) || "";
  }

  function orgId() {
    const user = grafanaRuntime.config && grafanaRuntime.config.bootData && grafanaRuntime.config.bootData.user;
    return user && user.orgId;
  }

  function proxyRoute(settings) {
    if (settings.provider === "groq") return "groq-chat";
    return settings.useAuth && settings._hasApiKey !== false ? "chat-auth" : "chat";
  }

  function modelsRoute(settings) {
    if (settings.provider === "groq") return "groq-models";
    return settings.useAuth && settings._hasApiKey !== false ? "models-auth" : "models";
  }

  function proxyUrl(route) {
    return `${appSubUrl()}/api/plugin-proxy/${PLUGIN_ID}/${route}`;
  }

  function modelName(settings) {
    return settings.provider === "groq" ? settings.groqModel : settings.model;
  }

  function shouldRetryWithoutStream(body, status, options) {
    return Boolean(body && body.stream && !(options && options.noStreamFallback) && [400, 405, 415, 422, 501].includes(Number(status)));
  }

  function estimateTokens(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value || "");
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  // ---------- Провайдер: запрос, стриминг, размышления ----------

  const patchContract =
    "Если предлагаешь изменить запрос существующей панели, дополнительно верни полный новый массив targets в блоке " +
    "```dashboard-json\\n{\"panelId\": 2, \"targets\": [...]}\\n```. " +
    "Не добавляй в этот блок другие поля и не меняй datasource без явной просьбы пользователя.";

  function textToolContract(settings) {
    return (
      "Ты можешь выполнять read-only запросы к datasource текущего дашборда (типы: " + investigationTypes(settings).join(", ") + "). " +
      "Чтобы выполнить запрос, ответь ТОЛЬКО блоками (не больше трёх) вида\n" +
      "```grafana-query\n{\"datasourceUid\": \"<uid из контекста>\", \"query\": {\"refId\": \"A\", \"expr\": \"...\"}, \"reason\": \"какую гипотезу проверяет\"}\n```\n" +
      "и больше ничего не пиши. Для Tempo используй {\"query\": \"<TraceQL>\", \"queryType\": \"traceql\"}. " +
      "Результаты придут следующим сообщением. Когда данных достаточно, дай итоговый ответ без блоков grafana-query. " +
      "Не выдумывай результаты запросов."
    );
  }

  const queryToolDefinition = {
    type: "function",
    function: {
      name: "query_grafana_datasource",
      description: "Выполнить дополнительный read-only запрос к datasource текущего дашборда. Используй только для проверки конкретной гипотезы.",
      parameters: {
        type: "object",
        properties: {
          datasourceUid: { type: "string", description: "UID datasource из текущего контекста" },
          query: { type: "object", description: "Query JSON для Grafana datasource, например {\"refId\":\"A\",\"expr\":\"...\"} для Loki или Prometheus" },
          reason: { type: "string", description: "Какую гипотезу проверяет запрос" },
        },
        required: ["datasourceUid", "query", "reason"],
      },
    },
  };

  function systemContent(settings, contextJson, mode) {
    return [
      settings.systemPrompt || defaults.systemPrompt,
      patchContract,
      mode === "text" ? textToolContract(settings) : "",
    ].filter(Boolean).join("\n") + CONTEXT_MARKER + contextJson;
  }

  function requestBody(settings, contextJson, messages, options) {
    options = options || {};
    const body = {
      model: modelName(settings),
      stream: settings.streaming !== false,
      messages: [{ role: "system", content: systemContent(settings, contextJson, options.mode) }].concat(messages),
    };
    if (settings.reasoningEffort) body.reasoning_effort = settings.reasoningEffort;
    const maxTokens = Number(settings.maxTokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    if (options.mode === "native") {
      body.tools = [queryToolDefinition];
      body.tool_choice = options.last ? "none" : "auto";
    }
    return body;
  }

  // Размышления reasoning-моделей (Qwen3, DeepSeek-R1 и др.) приходят в <think>…</think> внутри content.
  function splitThink(text) {
    const value = String(text || "");
    const open = value.indexOf("<think>");
    if (open === -1) return { content: value, reasoning: "" };
    const close = value.indexOf("</think>", open);
    if (close === -1) return { content: value.slice(0, open).trim(), reasoning: value.slice(open + 7).trim() };
    const rest = splitThink(value.slice(0, open) + value.slice(close + 8));
    return { content: rest.content.trim(), reasoning: [value.slice(open + 7, close).trim(), rest.reasoning].filter(Boolean).join("\n") };
  }

  function emptyAccumulator() {
    return { content: "", reasoning: "", toolCalls: [], finishReason: undefined };
  }

  function applyChoice(acc, choice) {
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === "string") acc.content += delta.content;
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (typeof reasoning === "string") acc.reasoning += reasoning;
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((call, position) => {
        const index = Number.isInteger(call.index) ? call.index : position;
        const slot = acc.toolCalls[index] || (acc.toolCalls[index] = { id: "", type: "function", function: { name: "", arguments: "" } });
        if (call.id) slot.id = call.id;
        const fn = call.function || {};
        if (fn.name) slot.function.name = fn.name;
        if (fn.arguments != null) slot.function.arguments += typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
      });
    }
    if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  }

  async function readEventStream(response, onDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const acc = emptyAccumulator();
    let buffer = "";
    let sawData = false;
    function handleLine(rawLine) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let json;
      try {
        json = JSON.parse(data);
      } catch (_) {
        return;
      }
      sawData = true;
      if (json.error) throw { status: response.status, data: json };
      applyChoice(acc, json.choices && json.choices[0]);
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (onDelta) onDelta(acc);
    }
    buffer += decoder.decode();
    // Провайдер мог проигнорировать stream и вернуть обычный JSON.
    if (!sawData && buffer.trim().startsWith("{")) {
      const json = JSON.parse(buffer);
      if (json.error) throw { status: response.status, data: json };
      applyChoice(acc, json.choices && json.choices[0]);
    } else {
      handleLine(buffer);
    }
    acc.toolCalls = acc.toolCalls.filter(Boolean);
    if (onDelta) onDelta(acc);
    return acc;
  }

  async function postChat(settings, body, options) {
    options = options || {};
    if (settings.provider === "groq" && settings._hasGroqApiKey === false) throw new Error("Для Groq не задан API key");
    if (settings.provider !== "groq") normalizePath(settings.apiPath);
    const headers = { "Content-Type": "application/json", Accept: body.stream ? "text/event-stream" : "application/json" };
    if (orgId()) headers["X-Grafana-Org-Id"] = String(orgId());
    const response = await fetch(proxyUrl(proxyRoute(settings)), {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { message: text.slice(0, 500) || response.statusText };
      }
      if (shouldRetryWithoutStream(body, response.status, options)) {
        return postChat(settings, Object.assign({}, body, { stream: false }), Object.assign({}, options, { noStreamFallback: true }));
      }
      throw { status: response.status, data };
    }
    const type = response.headers.get("content-type") || "";
    if (response.body && (type.includes("text/event-stream") || (body.stream && !type.includes("application/json")))) return readEventStream(response, options.onDelta);
    const json = await response.json();
    if (json.error) throw { status: response.status, data: json };
    const acc = emptyAccumulator();
    applyChoice(acc, json.choices && json.choices[0]);
    if (!json.choices || !json.choices[0]) throw new Error("Провайдер вернул ответ без choices[0]");
    if (options.onDelta) options.onDelta(acc);
    return acc;
  }

  // ---------- Безопасность контекста ----------

  function roleLevel(role) {
    return { Viewer: 1, Editor: 2, Admin: 3 }[role] || 0;
  }

  function assertAllowedRole(settings) {
    const user = grafanaRuntime.config.bootData && grafanaRuntime.config.bootData.user;
    const role = user && user.orgRole ? user.orgRole : "Viewer";
    if (roleLevel(role) < roleLevel(settings.minimumRole || "Viewer")) {
      throw new Error(`Для AI Assistant требуется роль ${settings.minimumRole} или выше`);
    }
  }

  function redactString(value) {
    return String(value)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(?:gsk_|sk-|AIza)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
      .replace(/([?&](?:token|api_key|apikey|password|secret)=)[^&\s]+/gi, "$1[REDACTED]");
  }

  function sanitizeForAI(value, depth, seen) {
    depth = depth || 0;
    seen = seen || new WeakSet();
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return redactString(value);
    if (typeof value !== "object" || depth > 12) return "[OMITTED]";
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForAI(item, depth + 1, seen));
    const result = {};
    Object.keys(value).slice(0, 200).forEach((key) => {
      if (/password|passwd|secret|token|api.?key|authorization|cookie/i.test(key)) result[key] = "[REDACTED]";
      else result[key] = sanitizeForAI(value[key], depth + 1, seen);
    });
    return result;
  }

  function configuredDatasourceAllowlist(settings) {
    return new Set(String(settings.allowedDatasourceUids || "").split(",").map((item) => item.trim()).filter(Boolean));
  }

  function investigationTypes(settings) {
    return String(settings.investigationDatasourceTypes || defaults.investigationDatasourceTypes).split(",").map((item) => item.trim()).filter(Boolean);
  }

  function datasourceUid(panel, target) {
    const datasource = (target && target.datasource) || panel.datasource || {};
    return typeof datasource === "string" ? datasource : datasource.uid;
  }

  function isDatasourceAllowed(settings, panel, target) {
    const allowlist = configuredDatasourceAllowlist(settings);
    return allowlist.size === 0 || allowlist.has(datasourceUid(panel, target));
  }

  // ---------- Данные панелей ----------

  function rangeMilliseconds(value, fallback) {
    try {
      const parsed = grafanaData.dateMath && grafanaData.dateMath.parse(value || fallback, fallback === "now");
      if (parsed) return parsed.valueOf();
    } catch (_) {}
    return fallback === "now" ? Date.now() : Date.now() - 3600000;
  }

  function summarizeFrame(frame, maxRows) {
    const schema = frame && frame.schema ? frame.schema : {};
    const fields = Array.isArray(schema.fields) ? schema.fields : [];
    const values = frame && frame.data && Array.isArray(frame.data.values) ? frame.data.values : [];
    const totalRows = values.reduce((max, column) => Math.max(max, Array.isArray(column) ? column.length : 0), 0);
    const rowCount = Math.min(maxRows, totalRows);
    const rows = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = {};
      fields.forEach((field, fieldIndex) => { row[field.name || `field_${fieldIndex}`] = values[fieldIndex] && values[fieldIndex][rowIndex]; });
      rows.push(row);
    }
    const meta = schema.meta || {};
    return {
      name: schema.name,
      refId: schema.refId,
      fields: fields.map((field) => ({ name: field.name, type: field.type, labels: field.labels })),
      totalRows,
      rows,
      executedQuery: meta.executedQueryString ? redactString(meta.executedQueryString).slice(0, 4000) : undefined,
      notices: meta.notices,
    };
  }

  function summarizeQueryResult(result, maxRows) {
    if (!result) return { error: "Пустой ответ datasource" };
    return {
      status: result.status,
      error: result.error || (result.frames && result.frames[0] && result.frames[0].schema && result.frames[0].schema.meta && result.frames[0].schema.meta.custom && result.frames[0].schema.meta.custom.error) || undefined,
      frames: Array.isArray(result.frames) ? result.frames.slice(0, 4).map((frame) => summarizeFrame(frame, maxRows)) : [],
    };
  }

  function deepReplace(value, replace) {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map((item) => deepReplace(item, replace));
    if (value && typeof value === "object") {
      const result = {};
      Object.keys(value).forEach((key) => { result[key] = key === "datasource" ? value[key] : deepReplace(value[key], replace); });
      return result;
    }
    return value;
  }

  // Подставляет значения переменных дашборда так же, как это делает сам datasource перед запросом.
  async function interpolateQuery(query) {
    try {
      const srv = grafanaRuntime.getDataSourceSrv && grafanaRuntime.getDataSourceSrv();
      const datasource = srv && query.datasource ? await srv.get(query.datasource) : undefined;
      if (datasource && typeof datasource.interpolateVariablesInQueries === "function") {
        const [interpolated] = datasource.interpolateVariablesInQueries([query], {});
        const ref = typeof datasource.getRef === "function" ? datasource.getRef() : query.datasource;
        return Object.assign({}, query, interpolated, { datasource: ref });
      }
      if (datasource && typeof datasource.getRef === "function") query = Object.assign({}, query, { datasource: datasource.getRef() });
    } catch (_) {}
    try {
      const templateSrv = grafanaRuntime.getTemplateSrv && grafanaRuntime.getTemplateSrv();
      if (templateSrv) return deepReplace(query, (text) => templateSrv.replace(text));
    } catch (_) {}
    return query;
  }

  function panelMaxRows(settings) {
    return Math.max(1, Math.min(100, Number(settings.maxPanelRows) || 20));
  }

  async function runDatasourceQueries(context, queries) {
    const from = rangeMilliseconds(context.timeRange && context.timeRange.from, "now-1h");
    const to = rangeMilliseconds(context.timeRange && context.timeRange.to, "now");
    const response = await grafanaRuntime.getBackendSrv().post("/api/ds/query", { from: String(from), to: String(to), queries });
    return response && response.results ? response.results : {};
  }

  async function loadPanelData(settings, context) {
    if (settings.includePanelData === false) return [];
    const panels = context.panel ? [context.panel] : (context.panels || []).slice(0, 4);
    const maxRows = panelMaxRows(settings);
    return Promise.all(panels.map(async (panel) => {
      const targets = (panel.targets || []).filter((target) => !target.hide && isDatasourceAllowed(settings, panel, target)).slice(0, 4);
      if (!targets.length) return { panelId: panel.id, title: panel.title, skipped: "Нет запросов или datasource не входит в allowlist" };
      try {
        const queries = await Promise.all(targets.map((target, index) => interpolateQuery(Object.assign({}, target, {
          refId: target.refId || String.fromCharCode(65 + index),
          datasource: target.datasource || panel.datasource,
          maxDataPoints: Math.min(Number(target.maxDataPoints) || 100, 500),
          intervalMs: Number(target.intervalMs) || 60000,
        }))));
        const results = await runDatasourceQueries(context, queries);
        return {
          panelId: panel.id,
          title: panel.title,
          datasourceUid: datasourceUid(panel, queries[0]),
          queries: queries.map((query) => sanitizeForAI(query)),
          results: Object.keys(results).map((refId) => ({ refId, result: summarizeQueryResult(results[refId], maxRows) })),
        };
      } catch (reason) {
        return { panelId: panel.id, title: panel.title, datasourceUid: datasourceUid(panel, targets[0]), error: formatError(reason) };
      }
    }));
  }

  function contextDatasources(context) {
    const panels = context.panel ? [context.panel] : (context.panels || []);
    const result = new Map();
    panels.forEach((panel) => {
      [panel.datasource].concat((panel.targets || []).map((target) => target.datasource)).filter(Boolean).forEach((datasource) => {
        if (typeof datasource === "object" && datasource.uid) result.set(datasource.uid, { uid: datasource.uid, type: datasource.type });
      });
    });
    (context.panelData || []).forEach((item) => (item.queries || []).forEach((query) => {
      const datasource = query.datasource;
      if (datasource && typeof datasource === "object" && datasource.uid && !result.has(datasource.uid)) result.set(datasource.uid, { uid: datasource.uid, type: datasource.type });
    }));
    return result;
  }

  async function executeQueryTool(settings, context, args) {
    if (!args || typeof args !== "object") throw new Error("Некорректные аргументы запроса");
    const sources = contextDatasources(context);
    const source = sources.get(args.datasourceUid);
    if (!source) throw new Error(`Datasource ${args.datasourceUid} отсутствует в текущем дашборде`);
    if (!investigationTypes(settings).includes(source.type)) throw new Error(`Дополнительные запросы к ${source.type} запрещены настройками`);
    if (!isDatasourceAllowed(settings, { datasource: source }, { datasource: source })) throw new Error(`Datasource ${source.uid} не входит в allowlist`);
    if (!args.query || typeof args.query !== "object" || Array.isArray(args.query)) throw new Error("Query должен быть объектом");
    const query = await interpolateQuery(Object.assign({}, args.query, {
      datasource: source,
      refId: args.query.refId || "AI",
      maxDataPoints: Math.min(Number(args.query.maxDataPoints) || 100, 500),
      intervalMs: Number(args.query.intervalMs) || 60000,
    }));
    const results = await runDatasourceQueries(context, [query]);
    return sanitizeForAI({
      reason: args.reason,
      datasource: source,
      query,
      results: Object.keys(results).map((refId) => ({ refId, result: summarizeQueryResult(results[refId], panelMaxRows(settings)) })),
    });
  }

  function parseTextToolCalls(content) {
    const calls = [];
    const pattern = /```grafana-query\s*([\s\S]*?)```/gi;
    let match;
    while ((match = pattern.exec(String(content || ""))) && calls.length < 3) {
      try {
        calls.push({ args: JSON.parse(match[1]) });
      } catch (_) {
        calls.push({ error: "Блок grafana-query не является корректным JSON" });
      }
    }
    return calls;
  }

  function stepSummary(args, result, error) {
    const query = (result && result.query) || (args && args.query) || {};
    const step = {
      reason: args && args.reason,
      datasource: result && result.datasource,
      expr: query.expr || (typeof query.query === "string" ? query.query : undefined) || JSON.stringify(query).slice(0, 300),
      query,
    };
    if (error) step.error = error;
    else {
      const results = (result && result.results) || [];
      const firstError = results.map((item) => item.result && item.result.error).find(Boolean);
      if (firstError) step.error = firstError;
      else step.rows = results.reduce((sum, item) => sum + ((item.result && item.result.frames) || []).reduce((acc, frame) => acc + (frame.totalRows || 0), 0), 0);
    }
    return step;
  }

  // Диалог с моделью. mode: off — без запросов; text — запросы через блоки grafana-query (работает с любой моделью);
  // native — OpenAI tools; auto — native с откатом на text, если провайдер не принимает tools.
  async function runAssistant(settings, context, contextJson, messages, options) {
    let mode = options.queries ? (settings.toolsMode || "text") : "off";
    let fallback = false;
    if (mode === "auto") {
      mode = "native";
      fallback = true;
    }
    const conversation = messages.slice();
    const steps = [];
    const rounds = mode === "off" ? 1 : MAX_TOOL_ROUNDS;
    for (let round = 0; round < rounds; round += 1) {
      const last = round === rounds - 1;
      let result;
      try {
        result = await postChat(settings, requestBody(settings, contextJson, conversation, { mode, last }), {
          signal: options.signal,
          onDelta: (acc) => {
            const split = splitThink(acc.content);
            options.onUpdate({ content: split.content, reasoning: [acc.reasoning, split.reasoning].filter(Boolean).join("\n"), steps });
          },
        });
      } catch (reason) {
        if (fallback && mode === "native" && reason && reason.status >= 400 && reason.status < 500 && round === 0) {
          mode = "text";
          round -= 1;
          continue;
        }
        throw reason;
      }
      const split = splitThink(result.content);
      const reasoning = [result.reasoning, split.reasoning].filter(Boolean).join("\n");
      if (mode === "native" && !last && result.toolCalls.length) {
        const calls = result.toolCalls.slice(0, 3);
        conversation.push({ role: "assistant", content: result.content || null, tool_calls: calls });
        for (const call of calls) {
          let args;
          let toolResult;
          try {
            args = JSON.parse(call.function.arguments || "{}");
            toolResult = await executeQueryTool(settings, context, args);
            steps.push(stepSummary(args, toolResult));
          } catch (reason) {
            toolResult = { error: formatError(reason) };
            steps.push(stepSummary(args, undefined, toolResult.error));
          }
          conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult).slice(0, 30000) });
        }
        options.onUpdate({ content: "", reasoning, steps });
        continue;
      }
      const textCalls = mode === "text" && !last ? parseTextToolCalls(split.content) : [];
      if (textCalls.length) {
        conversation.push({ role: "assistant", content: split.content });
        const outputs = [];
        for (const call of textCalls) {
          try {
            if (call.error) throw new Error(call.error);
            const toolResult = await executeQueryTool(settings, context, call.args);
            steps.push(stepSummary(call.args, toolResult));
            outputs.push(toolResult);
          } catch (reason) {
            const error = formatError(reason);
            steps.push(stepSummary(call.args, undefined, error));
            outputs.push({ request: call.args, error });
          }
        }
        const finalHint = round === rounds - 2 ? "\nЭто последний раунд запросов: теперь дай итоговый ответ без блоков grafana-query." : "";
        conversation.push({ role: "user", content: `Результаты запросов grafana-query:\n${JSON.stringify(outputs).slice(0, 30000)}${finalHint}` });
        options.onUpdate({ content: "", reasoning, steps });
        continue;
      }
      const content = mode === "text" ? split.content.replace(/```grafana-query[\s\S]*?```/gi, "").trim() : split.content;
      if (!content && !steps.length) throw new Error("Провайдер вернул пустой ответ");
      return { content: content || "Модель исчерпала лимит запросов и не дала итогового ответа.", reasoning, steps };
    }
    throw new Error("Расследование превысило лимит дополнительных запросов");
  }

  // ---------- Изменения дашборда ----------

  function parseDashboardProposal(content) {
    const match = /```dashboard-json\s*([\s\S]*?)```/i.exec(String(content || ""));
    if (!match) return undefined;
    try {
      const proposal = JSON.parse(match[1]);
      if (!Number.isFinite(Number(proposal.panelId)) || !Array.isArray(proposal.targets)) return undefined;
      return { panelId: Number(proposal.panelId), targets: proposal.targets };
    } catch (_) {
      return undefined;
    }
  }

  // Панели свёрнутых rows лежат в row.panels; у развёрнутых — на верхнем уровне после row.
  function flattenPanels(panels) {
    const result = [];
    let rowTitle;
    (Array.isArray(panels) ? panels : []).forEach((panel) => {
      if (!panel) return;
      if (panel.type === "row") {
        rowTitle = panel.title;
        (panel.panels || []).forEach((child) => result.push({ panel: child, row: panel.title }));
        return;
      }
      result.push({ panel, row: rowTitle });
    });
    return result;
  }

  function panelForProposal(context, proposal) {
    const panels = context.panel ? [context.panel] : (context.panels || []);
    return panels.find((panel) => Number(panel.id) === Number(proposal.panelId));
  }

  async function applyDashboardProposal(settings, context, proposal) {
    if (!context.dashboardUid) throw new Error("Изменение возможно только для сохранённого дашборда");
    const response = await grafanaRuntime.getBackendSrv().get(`/api/dashboards/uid/${encodeURIComponent(context.dashboardUid)}`);
    if (response.meta && response.meta.canSave === false) throw new Error("У пользователя нет права сохранять этот дашборд");
    const dashboard = response.dashboard;
    const entry = flattenPanels(dashboard.panels).find((item) => Number(item.panel.id) === Number(proposal.panelId));
    if (!entry) throw new Error(`Панель ${proposal.panelId} не найдена`);
    const panel = entry.panel;
    const existingUids = new Set((panel.targets || []).map((target) => datasourceUid(panel, target)).filter(Boolean));
    proposal.targets.forEach((target) => {
      const uid = datasourceUid(panel, target);
      if (uid && !existingUids.has(uid)) throw new Error(`AI попытался заменить datasource на ${uid}; изменение заблокировано`);
      if (!isDatasourceAllowed(settings, panel, target)) throw new Error(`Datasource ${uid} не входит в allowlist`);
    });
    panel.targets = proposal.targets;
    try {
      await grafanaRuntime.getBackendSrv().post("/api/dashboards/db", {
        dashboard,
        folderUid: response.meta && response.meta.folderUid,
        overwrite: false,
        message: "Tech AI Assistant: update panel queries",
      }, { showErrorAlert: false });
    } catch (reason) {
      if (reason && reason.status === 412) throw new Error("Дашборд изменён кем-то ещё после загрузки. Обновите страницу и примените заново.");
      throw reason;
    }
  }

  // ---------- Снимок экрана ----------

  function imageMessage(prompt, screenshot) {
    if (!screenshot) return prompt;
    return [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: screenshot.dataUrl } },
    ];
  }

  function screenshotNote(screenshot) {
    if (!screenshot) return "";
    return `\n\n📷 Передан снимок: ${screenshot.width}×${screenshot.height}, ${Math.ceil(screenshot.bytes / 1024)} КБ`;
  }

  function panelDataNote(context) {
    const data = context && Array.isArray(context.panelData) ? context.panelData : [];
    if (!data.length) return "";
    const errors = data.filter((item) => item.error || item.skipped).length;
    return `\n📊 Переданы результаты панелей: ${data.length}${errors ? `, с ошибками: ${errors}` : ""}`;
  }

  const quickPrompts = [
    { label: "Объяснить", prompt: "Объясни назначение выбранной панели или дашборда, запросы и фактические результаты простым техническим языком." },
    { label: "Исправить запрос", prompt: "Найди ошибки в запросах выбранной панели. Предложи исправленный запрос и dashboard-json для безопасного применения." },
    { label: "Оптимизировать", prompt: "Проверь запросы выбранной панели на производительность и стоимость. Предложи оптимизированный вариант и dashboard-json." },
    { label: "Расследовать", queries: true, prompt: "Проведи расследование по текущему диапазону времени. Сопоставь фактические результаты панелей, при необходимости выполни дополнительные read-only запросы, сформируй гипотезы, доказательства, исходные запросы и следующие проверки. Не выдавай гипотезы за факты." },
  ];

  async function captureDashboardScreenshot(extraHiddenElement) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("Захват экрана недоступен. Нужен HTTPS или localhost и совместимый браузер.");
    }

    const hidden = [
      document.getElementById("tech-ai-assistant-drawer"),
      document.getElementById("tech-ai-assistant-launcher"),
      extraHiddenElement,
    ].filter(Boolean);
    const previousVisibility = hidden.map((element) => element.style.visibility);
    hidden.forEach((element) => { element.style.visibility = "hidden"; });

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      });
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw new Error("Браузер не вернул кадр выбранной вкладки");

      const scale = Math.min(1, 1600 / video.videoWidth, 1200 / video.videoHeight);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
      const base64Length = dataUrl.length - dataUrl.indexOf(",") - 1;
      return { dataUrl, width, height, bytes: Math.floor(base64Length * 0.75) };
    } catch (reason) {
      if (reason && reason.name === "NotAllowedError") {
        throw new Error("Снимок отменён или запрещён браузером. Запрос не отправлен.");
      }
      throw reason;
    } finally {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      hidden.forEach((element, index) => { element.style.visibility = previousVisibility[index]; });
    }
  }

  // ---------- Контекст страницы ----------

  function dashboardUid() {
    const explicitUid = new URLSearchParams(location.search).get("dashboardUid");
    if (explicitUid) return explicitUid;
    const subPath = appSubUrl();
    const path = subPath && location.pathname.startsWith(subPath) ? location.pathname.slice(subPath.length) : location.pathname;
    const match = /\/d\/([^/]+)/.exec(path);
    return match ? match[1] : undefined;
  }

  function primitiveContext(value) {
    if (!value || typeof value !== "object") return undefined;
    const result = {};
    ["panelId", "id", "pluginId", "title", "type"].forEach((key) => {
      if (["string", "number", "boolean"].includes(typeof value[key])) result[key] = value[key];
    });
    if (value.panel && typeof value.panel === "object") {
      result.panel = {};
      ["id", "title", "type", "pluginId"].forEach((key) => {
        if (["string", "number", "boolean"].includes(typeof value.panel[key])) result.panel[key] = value.panel[key];
      });
    }
    ["datasource", "dataSource", "range", "timeRange"].forEach((key) => {
      if (value[key] && typeof value[key] === "object") result[key] = sanitizeForAI(value[key]);
      else if (["string", "number", "boolean"].includes(typeof value[key])) result[key] = value[key];
    });
    if (Array.isArray(value.queries)) result.queries = sanitizeForAI(value.queries.slice(0, 10));
    if (Array.isArray(value.targets)) result.targets = sanitizeForAI(value.targets.slice(0, 10));
    return result;
  }

  function panelId(extensionContext) {
    const params = new URLSearchParams(location.search);
    const candidates = [
      extensionContext && extensionContext.panelId,
      extensionContext && extensionContext.id,
      extensionContext && extensionContext.panel && extensionContext.panel.id,
      params.get("editPanel"),
      params.get("viewPanel"),
      params.get("panelId"),
    ];
    for (const candidate of candidates) {
      const number = Number(String(candidate == null ? "" : candidate).replace(/^panel-/, ""));
      if (Number.isFinite(number) && number > 0) return number;
    }
    return undefined;
  }

  function summarizePanel(entry) {
    const panel = entry.panel;
    return {
      id: panel.id,
      title: panel.title,
      row: entry.row,
      type: panel.type,
      description: panel.description,
      datasource: panel.datasource,
      targets: panel.targets,
      transformations: panel.transformations,
      fieldConfig: panel.fieldConfig,
    };
  }

  // Текущие значения переменных: из состояния дашборда, а если оно недоступно — из URL.
  function currentVariables(params) {
    const variables = {};
    try {
      const templateSrv = grafanaRuntime.getTemplateSrv && grafanaRuntime.getTemplateSrv();
      const list = templateSrv && typeof templateSrv.getVariables === "function" ? templateSrv.getVariables() : [];
      (list || []).forEach((variable) => {
        if (!variable || !variable.name) return;
        const current = variable.current || {};
        variables[variable.name] = current.value !== undefined ? current.value : current.text;
      });
    } catch (_) {}
    params.forEach((value, key) => {
      if (!key.startsWith("var-")) return;
      const name = key.slice(4);
      if (variables[name] !== undefined) return;
      const all = params.getAll(key);
      variables[name] = all.length > 1 ? all : value;
    });
    return variables;
  }

  async function loadContext(extensionContext) {
    const params = new URLSearchParams(location.search);
    const uid = dashboardUid();
    const context = {
      pageUrl: location.href,
      appSubUrl: appSubUrl(),
      dashboardUid: uid,
      timeRange: { from: params.get("from"), to: params.get("to"), timezone: params.get("timezone") },
      variables: currentVariables(params),
      extension: primitiveContext(extensionContext),
    };
    if (!uid) return context;

    const response = await grafanaRuntime.getBackendSrv().get(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
    const dashboard = response && response.dashboard;
    if (!dashboard) return context;
    context.dashboardTitle = dashboard.title;
    context.dashboardSource = "Сохранённая версия дашборда; несохранённые правки не видны";
    context.tags = dashboard.tags;
    if (!context.timeRange.from && dashboard.time) context.timeRange.from = dashboard.time.from;
    if (!context.timeRange.to && dashboard.time) context.timeRange.to = dashboard.time.to;
    const entries = flattenPanels(dashboard.panels);
    const selectedId = panelId(extensionContext);
    const selected = entries.find((item) => Number(item.panel.id) === selectedId);
    if (selected) context.panel = summarizePanel(selected);
    else context.panels = entries.map(summarizePanel);
    return context;
  }

  async function contextWithLiveData(settings, context) {
    const next = Object.assign({}, context);
    next.panelData = await loadPanelData(settings, context);
    return sanitizeForAI(next);
  }

  // ---------- Бюджет контекста ----------

  function mapPanels(context, transform) {
    if (!Array.isArray(context.panels)) return context;
    return Object.assign({}, context, { panels: context.panels.map(transform) });
  }

  function omit(object, keys) {
    const result = Object.assign({}, object);
    keys.forEach((key) => { delete result[key]; });
    return result;
  }

  function shrinkPanelData(context, rows) {
    if (!Array.isArray(context.panelData)) return context;
    return Object.assign({}, context, {
      panelData: context.panelData.map((item) => Object.assign({}, item, {
        results: (item.results || []).map((entry) => Object.assign({}, entry, {
          result: Object.assign({}, entry.result, {
            frames: ((entry.result && entry.result.frames) || []).map((frame) => Object.assign({}, frame, { rows: (frame.rows || []).slice(0, rows) })),
          }),
        })),
      })),
    });
  }

  const contextReducers = [
    { label: "fieldConfig других панелей", apply: (c) => mapPanels(c, (p) => omit(p, ["fieldConfig", "transformations"])) },
    { label: "строки данных до 5", apply: (c) => shrinkPanelData(c, 5) },
    { label: "fieldConfig выбранной панели", apply: (c) => (c.panel ? Object.assign({}, c, { panel: omit(c.panel, ["fieldConfig"]) }) : c) },
    { label: "строки данных", apply: (c) => shrinkPanelData(c, 0) },
    { label: "описания панелей", apply: (c) => mapPanels(c, (p) => omit(p, ["description"])) },
    { label: "запросы других панелей", apply: (c) => mapPanels(c, (p) => ({ id: p.id, title: p.title, row: p.row, type: p.type, datasource: p.datasource })) },
    { label: "результаты панелей", apply: (c) => Object.assign({}, c, { panelData: (c.panelData || []).map((item) => ({ panelId: item.panelId, title: item.title, error: item.error, skipped: item.skipped })) }) },
    { label: "список панелей", apply: (c) => mapPanels(Object.assign({}, c, { panels: (c.panels || []).slice(0, 60) }), (p) => ({ id: p.id, title: p.title })) },
  ];

  // Уменьшает контекст по приоритетам, не разрезая JSON: сначала второстепенные поля, затем данные.
  function fitContext(context, budgetChars) {
    let current = context;
    let json = JSON.stringify(current);
    const reductions = [];
    for (const reducer of contextReducers) {
      if (json.length <= budgetChars) break;
      current = reducer.apply(current);
      reductions.push(reducer.label);
      json = JSON.stringify(current);
    }
    if (json.length > budgetChars) {
      current = {
        dashboardTitle: context.dashboardTitle,
        dashboardUid: context.dashboardUid,
        timeRange: context.timeRange,
        panel: context.panel ? { id: context.panel.id, title: context.panel.title, type: context.panel.type, datasource: context.panel.datasource, targets: context.panel.targets } : undefined,
        note: "Контекст сильно сокращён из-за лимита окна модели",
      };
      reductions.push("минимальный контекст");
      json = JSON.stringify(current);
      if (json.length > budgetChars) json = JSON.stringify({ note: "Контекст не поместился в окно модели", dashboardTitle: context.dashboardTitle });
    }
    return { json, reductions };
  }

  // Подрезает историю и контекст под contextTokens; резервирует место под ответ.
  function planRequest(settings, context, history, prompt) {
    const windowTokens = Number(settings.contextTokens) > 0 ? Number(settings.contextTokens) : 0;
    const replyReserve = Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : 1024;
    const fixedTokens = estimateTokens(systemContent(settings, "", settings.toolsMode === "text" ? "text" : "off")) + estimateTokens(prompt) + 50;
    let messages = history.slice();
    if (windowTokens) {
      const historyBudget = Math.floor(windowTokens * 0.35);
      while (messages.length && estimateTokens(messages) > historyBudget) messages = messages.slice(2);
    }
    const historyTokens = estimateTokens(messages);
    const contextBudgetTokens = windowTokens ? Math.max(500, windowTokens - replyReserve - fixedTokens - historyTokens) : 40000;
    const fitted = fitContext(context, contextBudgetTokens * CHARS_PER_TOKEN);
    return {
      messages,
      droppedMessages: history.length - messages.length,
      contextJson: fitted.json,
      reductions: fitted.reductions,
      totalTokens: fixedTokens + historyTokens + estimateTokens(fitted.json),
      windowTokens,
    };
  }

  // ---------- Markdown и ссылки в Explore ----------

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function markdownHtml(text) {
    if (typeof grafanaData.renderMarkdown === "function") {
      try {
        return grafanaData.renderMarkdown(text);
      } catch (_) {}
    }
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function splitContent(content) {
    const parts = [];
    const pattern = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
    let index = 0;
    let match;
    const text = String(content || "");
    while ((match = pattern.exec(text))) {
      if (match.index > index) parts.push({ type: "text", text: text.slice(index, match.index) });
      parts.push({ type: "code", lang: match[1].toLowerCase(), code: match[2].replace(/\n$/, "") });
      index = match.index + match[0].length;
    }
    if (index < text.length) parts.push({ type: "text", text: text.slice(index) });
    return parts.filter((part) => part.type === "code" || part.text.trim());
  }

  const languageDatasourceTypes = { promql: "prometheus", logql: "loki", traceql: "tempo" };

  function datasourceForLanguage(context, lang) {
    const type = languageDatasourceTypes[lang];
    if (!type || !context) return undefined;
    return Array.from(contextDatasources(context).values()).find((source) => source.type === type);
  }

  function exploreUrl(context, datasource, query) {
    if (!datasource || !datasource.uid) return undefined;
    const range = (context && context.timeRange) || {};
    const panes = { a: { datasource: datasource.uid, queries: [Object.assign({ refId: "A" }, query, { datasource: { type: datasource.type, uid: datasource.uid } })], range: { from: range.from || "now-1h", to: range.to || "now" } } };
    return `${appSubUrl()}/explore?schemaVersion=1&orgId=${orgId() || 1}&panes=${encodeURIComponent(JSON.stringify(panes))}`;
  }

  function exploreQueryFor(lang, code) {
    if (lang === "traceql") return { query: code, queryType: "traceql" };
    return { expr: code };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => legacyCopyText(text));
      return;
    }
    legacyCopyText(text);
  }

  function legacyCopyText(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    Object.assign(textarea.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand("copy"); } catch (_) {}
    textarea.remove();
  }

  function CodeBlock(props) {
    const datasource = datasourceForLanguage(props.context, props.lang);
    const url = datasource ? exploreUrl(props.context, datasource, exploreQueryFor(props.lang, props.code)) : undefined;
    return h("div", { style: styles.codeBlock },
      h("pre", { style: styles.pre }, props.code),
      h("div", { style: { display: "flex", gap: 6 } },
        h("button", { type: "button", style: styles.smallButton, onClick: () => copyText(props.code) }, "Копировать"),
        url ? h("a", { href: url, target: "_blank", rel: "noreferrer", style: Object.assign({}, styles.smallButton, { display: "inline-flex", alignItems: "center", textDecoration: "none" }) }, "Открыть в Explore") : null
      )
    );
  }

  function MessageContent(props) {
    return h("div", { style: styles.markdown },
      splitContent(props.content).map((part, index) => {
        if (part.type === "text") return h("div", { key: index, className: "markdown-html", dangerouslySetInnerHTML: { __html: markdownHtml(part.text) } });
        if (part.lang === "dashboard-json" || part.lang === "grafana-query") return null;
        return h(CodeBlock, { key: index, lang: part.lang, code: part.code, context: props.context });
      })
    );
  }

  function StepView(props) {
    const step = props.step;
    const url = step.datasource && step.query ? exploreUrl(props.context, step.datasource, omit(step.query, ["datasource", "maxDataPoints", "intervalMs"])) : undefined;
    return h("div", { style: styles.step },
      h("div", null, `🔎 ${step.reason || "Дополнительный запрос"}`),
      h("code", { style: { whiteSpace: "pre-wrap" } }, step.expr || ""),
      h("div", { style: styles.context },
        step.error ? `Ошибка: ${step.error}` : `Строк: ${step.rows || 0}`,
        url ? h(React.Fragment, null, " · ", h("a", { href: url, target: "_blank", rel: "noreferrer" }, "Открыть в Explore")) : null
      )
    );
  }

  // ---------- История диалога ----------

  function historyKey(context) {
    const selected = context && context.panel ? `:panel-${context.panel.id}` : "";
    const base = (context && context.dashboardUid) || location.pathname;
    return `tech-ai-chat:${base}${selected}`;
  }

  function loadHistory(key) {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value.filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") : [];
    } catch (_) {
      return [];
    }
  }

  function saveHistory(key, history) {
    try {
      sessionStorage.setItem(key, JSON.stringify(history.slice(-HISTORY_LIMIT)));
    } catch (_) {}
  }

  function apiHistory(history) {
    return history.filter((item) => !item.local).map((item) => ({ role: item.role, content: item.content }));
  }

  // ---------- Чат ----------

  function Assistant(props) {
    props = props || {};
    const [settings, setSettings] = React.useState();
    const [context, setContext] = React.useState();
    const [storageKey, setStorageKey] = React.useState();
    const [history, setHistory] = React.useState([]);
    const [pending, setPending] = React.useState();
    const [input, setInput] = React.useState(props.initialPrompt || "");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [includeScreenshot, setIncludeScreenshot] = React.useState(false);
    const [allowQueries, setAllowQueries] = React.useState(false);
    const [lastRequest, setLastRequest] = React.useState();
    const historyRef = React.useRef(null);
    const rootRef = React.useRef(null);
    const abortRef = React.useRef(null);

    React.useEffect(() => {
      let cancelled = false;
      Promise.all([getSettings(), loadContext(props.initialContext)])
        .then(([nextSettings, nextContext]) => {
          if (cancelled) return;
          const key = historyKey(nextContext);
          setSettings(nextSettings.jsonData);
          setContext(nextContext);
          setStorageKey(key);
          setHistory(loadHistory(key));
        })
        .catch((reason) => setError(`Не удалось загрузить настройки или контекст: ${formatError(reason)}`));
      return () => {
        cancelled = true;
        if (abortRef.current) abortRef.current.abort();
      };
    }, [props.initialContext]);

    React.useEffect(() => {
      if (storageKey) saveHistory(storageKey, history);
    }, [history, storageKey]);

    React.useEffect(() => {
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }, [history, pending]);

    async function send(promptOverride, action) {
      const prompt = String(promptOverride || input).trim();
      if (!prompt || busy || !settings || !context) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setError("");
      let partial = { content: "", reasoning: "", steps: [] };
      let userMessage;
      try {
        assertAllowedRole(settings);
        const screenshot = includeScreenshot ? await captureDashboardScreenshot(rootRef.current) : undefined;
        const requestContext = await contextWithLiveData(settings, context);
        setInput("");
        const plan = planRequest(settings, requestContext, apiHistory(history), prompt);
        userMessage = { role: "user", content: prompt, note: (screenshotNote(screenshot) + panelDataNote(requestContext)).trim() };
        setHistory((current) => current.concat([userMessage]));
        setPending(partial);
        setLastRequest({ contextJson: plan.contextJson, reductions: plan.reductions, totalTokens: plan.totalTokens, windowTokens: plan.windowTokens, droppedMessages: plan.droppedMessages });
        const messages = plan.messages.concat([{ role: "user", content: imageMessage(prompt, screenshot) }]);
        const result = await runAssistant(settings, requestContext, plan.contextJson, messages, {
          queries: Boolean((action && action.queries) || allowQueries),
          signal: controller.signal,
          onUpdate: (update) => {
            partial = update;
            setPending(Object.assign({}, update));
          },
        });
        setHistory((current) => current.concat([{ role: "assistant", content: result.content, reasoning: result.reasoning, steps: result.steps }]));
      } catch (reason) {
        if (reason && reason.name === "AbortError" && userMessage) {
          setHistory((current) => current.concat([{ role: "assistant", content: `${partial.content || ""}\n\n_(ответ остановлен)_`.trim(), reasoning: partial.reasoning, steps: partial.steps }]));
        } else {
          const message = formatError(reason);
          if (partial.content || partial.reasoning || (partial.steps || []).length) {
            setHistory((current) => current.concat([{
              role: "assistant",
              content: `${partial.content || ""}\n\n_(ответ не завершён: ${message})_`.trim(),
              reasoning: partial.reasoning,
              steps: partial.steps,
            }]));
          }
          setError(message);
        }
      } finally {
        abortRef.current = null;
        setPending(undefined);
        setBusy(false);
      }
    }

    function stop() {
      if (abortRef.current) abortRef.current.abort();
    }

    function newDialog() {
      if (busy) stop();
      setHistory([]);
      setError("");
      setLastRequest(undefined);
    }

    function proposalCard(message, index) {
      const proposal = parseDashboardProposal(message.content);
      if (!proposal) return null;
      const panel = panelForProposal(context, proposal);
      return h("div", { key: `proposal-${index}`, style: styles.proposal },
        h("strong", null, `Предложение для панели ${proposal.panelId}${panel && panel.title ? ` «${panel.title}»` : ""}`),
        h("div", { style: styles.diff },
          h("div", null, h("div", { style: styles.context }, "Было"), h("pre", { style: styles.pre }, JSON.stringify((panel && panel.targets) || [], null, 2))),
          h("div", null, h("div", { style: styles.context }, "Станет"), h("pre", { style: styles.pre }, JSON.stringify(proposal.targets, null, 2)))
        ),
        h("div", { style: styles.quickActions },
          h("button", { type: "button", style: styles.button, onClick: () => copyText(JSON.stringify(proposal, null, 2)) }, "Копировать JSON"),
          h("button", {
            type: "button",
            style: styles.button,
            onClick: async () => {
              if (!window.confirm(`Применить новые targets к панели ${proposal.panelId}?`)) return;
              try {
                await applyDashboardProposal(settings, context, proposal);
                const next = history.concat([{ role: "assistant", local: true, content: `✅ Новые запросы применены к панели ${proposal.panelId}. Страница перезагружается.` }]);
                saveHistory(storageKey, next);
                window.location.reload();
              } catch (reason) {
                setError(`Ошибка применения: ${formatError(reason)}`);
              }
            },
          }, "Применить к дашборду")
        )
      );
    }

    function messageView(message, index, isPending) {
      if (message.role === "user") {
        return h("div", { key: index, style: styles.user }, message.content + (message.note ? `\n${message.note}` : ""));
      }
      const content = isPending && !message.content && !(message.steps || []).length && !message.reasoning ? "…" : message.content;
      return h(React.Fragment, { key: index },
        h("div", { style: styles.assistant },
          message.reasoning ? h("details", { style: styles.context }, h("summary", { style: { cursor: "pointer" } }, isPending && !message.content ? "Размышляет…" : "Размышления модели"), h("div", { style: { whiteSpace: "pre-wrap" } }, message.reasoning)) : null,
          (message.steps || []).map((step, stepIndex) => h(StepView, { key: `step-${stepIndex}`, step, context })),
          isPending ? h("div", { style: { whiteSpace: "pre-wrap" } }, content) : h(MessageContent, { content, context })
        ),
        !isPending ? proposalCard(message, index) : null
      );
    }

    const ready = Boolean(settings && context);
    const statsLine = lastRequest
      ? `Последний запрос ≈${(lastRequest.totalTokens / 1000).toFixed(1)}k ток.${lastRequest.windowTokens ? ` из ${(lastRequest.windowTokens / 1000).toFixed(1)}k` : ""}` +
        (lastRequest.reductions.length ? ` · сжато: ${lastRequest.reductions.join(", ")}` : "") +
        (lastRequest.droppedMessages ? ` · в модель не ушли ранние сообщения: ${lastRequest.droppedMessages}` : "")
      : "";

    return h("div", { style: styles.root, ref: rootRef },
      h("div", { style: styles.header },
        h("div", { style: styles.context }, context
          ? `${context.dashboardTitle || "Текущая страница Grafana"}${context.panel ? ` · ${context.panel.title}` : ""}${settings ? ` · ${modelName(settings) || "модель не задана"}` : ""}`
          : "Загрузка контекста…"),
        h("button", { type: "button", style: styles.smallButton, disabled: !history.length && !busy, onClick: newDialog }, "Новый диалог")
      ),
      lastRequest ? h("details", { style: styles.context },
        h("summary", { style: { cursor: "pointer" } }, "Последний отправленный контекст"),
        h("pre", { style: styles.pre }, (() => {
          try {
            return JSON.stringify(JSON.parse(lastRequest.contextJson), null, 2);
          } catch (_) {
            return lastRequest.contextJson;
          }
        })())
      ) : null,
      error ? h("div", { style: styles.error, "data-testid": "tech-ai-error" }, error) : null,
      h("div", { style: styles.history, ref: historyRef },
        history.length === 0 && !pending ? h("div", { style: styles.context }, "Задайте вопрос по текущему дашборду или панели.") : null,
        history.map((message, index) => messageView(message, index, false)),
        pending ? messageView(Object.assign({ role: "assistant" }, pending), "pending", true) : null
      ),
      h("div", null,
        h("div", { style: styles.quickActions }, quickPrompts.map((action) =>
          h("button", { key: action.label, type: "button", style: styles.button, disabled: busy || !ready, onClick: () => send(action.prompt, action) }, action.label)
        )),
        h("div", { style: styles.options },
          h("label", { style: styles.attachment },
            h("input", { type: "checkbox", checked: allowQueries, disabled: busy, onChange: (event) => setAllowQueries(event.target.checked) }),
            " Разрешить AI выполнять запросы"
          ),
          h("label", { style: styles.attachment },
            h("input", { type: "checkbox", checked: includeScreenshot, disabled: busy, onChange: (event) => setIncludeScreenshot(event.target.checked) }),
            " Сделать и отправить снимок дашборда для анализа"
          )
        ),
        statsLine ? h("div", { style: Object.assign({}, styles.context, { marginBottom: 6, color: lastRequest.windowTokens && lastRequest.totalTokens > lastRequest.windowTokens ? "#e02f44" : styles.context.color }) }, statsLine) : null,
        h("div", { style: styles.composer },
          h("textarea", {
            style: styles.textarea,
            value: input,
            disabled: busy || !ready,
            placeholder: "Например: исправь PromQL этой панели",
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            },
          }),
          busy
            ? h("button", { type: "button", style: styles.stopButton, onClick: stop }, "Стоп")
            : h("button", { type: "button", style: styles.button, disabled: !input.trim() || !ready, onClick: () => send() }, "Отправить")
        )
      )
    );
  }

  // ---------- Конфигурация ----------

  function ConfigPage() {
    const [state, setState] = React.useState(defaults);
    const [apiKey, setApiKey] = React.useState("");
    const [groqApiKey, setGroqApiKey] = React.useState("");
    const [keyIsSet, setKeyIsSet] = React.useState(false);
    const [groqKeyIsSet, setGroqKeyIsSet] = React.useState(false);
    const [dirty, setDirty] = React.useState(false);
    const [status, setStatus] = React.useState("");
    const [checkStatus, setCheckStatus] = React.useState("");
    const [models, setModels] = React.useState([]);

    React.useEffect(() => {
      getSettings()
        .then((settings) => {
          setState(settings.jsonData);
          setKeyIsSet(Boolean(settings.secureJsonFields.apiKey));
          setGroqKeyIsSet(Boolean(settings.secureJsonFields.groqApiKey));
        })
        .catch((reason) => setStatus(formatError(reason)));
    }, []);

    function update(patch) {
      setState((current) => Object.assign({}, current, patch));
      setDirty(true);
    }

    function field(label, key, type, extra) {
      return h("label", { style: styles.field },
        h("span", null, label),
        h("input", Object.assign({
          style: styles.input,
          type: type || "text",
          value: state[key] == null ? "" : state[key],
          onChange: (event) => update({ [key]: type === "number" ? Number(event.target.value) : event.target.value }),
        }, extra || {}))
      );
    }

    function checkbox(label, key, defaultValue) {
      return h("label", null,
        h("input", { type: "checkbox", checked: state[key] === undefined ? defaultValue : Boolean(state[key]), onChange: (event) => update({ [key]: event.target.checked }) }),
        ` ${label}`
      );
    }

    function applyPreset(name) {
      const preset = providerPresets[name];
      if (!preset) return;
      update(omit(preset, ["label"]));
    }

    async function save() {
      setStatus("Сохранение…");
      try {
        const jsonData = Object.assign({}, omit(state, ["_hasApiKey", "_hasGroqApiKey"]), { apiPath: state.provider === "groq" ? state.apiPath : normalizePath(state.apiPath), modelsPath: state.modelsPath ? normalizePath(state.modelsPath) : "" });
        const data = { enabled: true, pinned: true, jsonData };
        if (apiKey || groqApiKey) data.secureJsonData = Object.assign({}, apiKey ? { apiKey } : {}, groqApiKey ? { groqApiKey } : {});
        await grafanaRuntime.getBackendSrv().post(`/api/plugins/${PLUGIN_ID}/settings`, data);
        cachedSettings = Object.assign({}, defaults, jsonData);
        localStorage.setItem("tech-ai-launcher-mode", jsonData.launcherMode || "both");
        setState(jsonData);
        setApiKey("");
        setGroqApiKey("");
        if (apiKey) setKeyIsSet(true);
        if (groqApiKey) setGroqKeyIsSet(true);
        setDirty(false);
        setStatus("Сохранено. Для изменения способа запуска обновите страницу Grafana.");
      } catch (reason) {
        setStatus(formatError(reason));
      }
    }

    async function testConnection() {
      setCheckStatus("Проверка сохранённых настроек…");
      const started = Date.now();
      try {
        const saved = (await getSettings()).jsonData;
        const result = await postChat(saved, { model: modelName(saved), stream: false, max_tokens: 64, messages: [{ role: "user", content: "Ответь одним словом: ok" }] });
        const answer = splitThink(result.content).content || (result.reasoning ? "(только размышления)" : "(пустой ответ)");
        setCheckStatus(`✅ ${modelName(saved)} ответила за ${((Date.now() - started) / 1000).toFixed(1)} с: «${answer.slice(0, 80)}»`);
      } catch (reason) {
        setCheckStatus(`❌ ${formatError(reason)}`);
      }
    }

    async function loadModels() {
      setCheckStatus("Загрузка списка моделей…");
      try {
        const settings = await getSettings();
        if (settings.jsonData.provider !== "groq" && !settings.savedJsonData.modelsPath) throw new Error("Сначала сохраните настройки, чтобы задать путь к списку моделей");
        const response = await grafanaRuntime.getBackendSrv().get(`/api/plugin-proxy/${PLUGIN_ID}/${modelsRoute(settings.jsonData)}`, undefined, undefined, { showErrorAlert: false });
        const list = ((response && (response.data || response.models)) || []).map((item) => item.id || item.name).filter(Boolean).sort();
        setModels(list);
        setCheckStatus(list.length ? `Найдено моделей: ${list.length}. Выберите в поле Model.` : "Провайдер вернул пустой список моделей");
      } catch (reason) {
        setCheckStatus(`❌ ${formatError(reason)}`);
      }
    }

    const modelField = state.provider === "groq" ? "groqModel" : "model";
    return h("div", { style: styles.config },
      h("h2", null, "Tech AI Assistant"),
      h("label", { style: styles.field },
        h("span", null, "Шаблон провайдера (заполняет поля ниже)"),
        h("select", { style: styles.input, value: "", onChange: (event) => applyPreset(event.target.value) },
          h("option", { value: "" }, "Выберите шаблон…"),
          Object.keys(providerPresets).map((name) => h("option", { key: name, value: name }, providerPresets[name].label))
        )
      ),
      h("label", { style: styles.field },
        h("span", null, "Provider"),
        h("select", { style: styles.input, value: state.provider || "custom", onChange: (event) => update({ provider: event.target.value }) },
          h("option", { value: "custom" }, "Custom / локальная / OpenAI-compatible"),
          h("option", { value: "groq" }, "Groq Free")
        )
      ),
      state.provider === "groq"
        ? h(React.Fragment, null,
            h("div", { style: styles.context }, "Endpoint: https://api.groq.com/openai/v1/chat/completions"),
            h("label", { style: styles.field },
              h("span", null, `Groq API key${groqKeyIsSet ? " (уже сохранён)" : ""}`),
              h("input", { style: styles.input, type: "password", value: groqApiKey, placeholder: groqKeyIsSet ? "Оставьте пустым, чтобы не менять" : "gsk_…", onChange: (event) => { setGroqApiKey(event.target.value); setDirty(true); } })
            )
          )
        : h(React.Fragment, null,
            field("API URL (как его видит сервер Grafana, например http://ollama:11434)", "apiUrl"),
            field("Chat completions path", "apiPath"),
            field("Models path (для списка моделей)", "modelsPath"),
            h("label", { style: styles.field },
              h("span", null, `API key${keyIsSet ? " (уже сохранён)" : ""}`),
              h("input", { style: styles.input, type: "password", value: apiKey, placeholder: keyIsSet ? "Оставьте пустым, чтобы не менять" : "", onChange: (event) => { setApiKey(event.target.value); setDirty(true); } })
            ),
            checkbox("Передавать Authorization header", "useAuth", true),
            state.useAuth !== false && state._hasApiKey === false ? h("div", { style: styles.context }, "API key пустой — Authorization header отправляться не будет.") : null,
            field("Authorization scheme", "authScheme")
          ),
      field(state.provider === "groq" ? "Groq model" : "Model", modelField, "text", { list: "tech-ai-models" }),
      h("datalist", { id: "tech-ai-models" }, models.map((name) => h("option", { key: name, value: name }))),
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
        h("button", { type: "button", style: styles.button, onClick: testConnection }, "Проверить подключение"),
        h("button", { type: "button", style: styles.button, onClick: loadModels }, "Загрузить список моделей"),
        dirty ? h("span", { style: styles.context }, "Проверяются сохранённые настройки — сначала сохраните изменения") : null
      ),
      checkStatus ? h("div", { style: { whiteSpace: "pre-wrap" } }, checkStatus) : null,
      field("Окно контекста модели, токенов (0 = без ограничения). Для Ollama задайте такой же OLLAMA_CONTEXT_LENGTH / num_ctx", "contextTokens", "number"),
      field("Max output tokens (0 = provider default)", "maxTokens", "number"),
      field("Reasoning effort (optional)", "reasoningEffort"),
      checkbox("Потоковый вывод ответа (stream)", "streaming", true),
      h("label", { style: styles.field },
        h("span", null, "Как модель выполняет дополнительные запросы"),
        h("select", { style: styles.input, value: state.toolsMode || "text", onChange: (event) => update({ toolsMode: event.target.value }) },
          h("option", { value: "text" }, "Текстовый протокол — работает с любой моделью (рекомендуется)"),
          h("option", { value: "auto" }, "Native tools, при ошибке провайдера — текстовый протокол"),
          h("option", { value: "native" }, "Только native tools (OpenAI function calling)")
        )
      ),
      field("Типы datasource для дополнительных запросов через запятую", "investigationDatasourceTypes"),
      h("label", { style: styles.field },
        h("span", null, "Способ запуска"),
        h("select", { style: styles.input, value: state.launcherMode || "both", onChange: (event) => update({ launcherMode: event.target.value }) },
          h("option", { value: "both" }, "Кнопка AI и Command Palette"),
          h("option", { value: "floating" }, "Только кнопка AI"),
          h("option", { value: "commandPalette" }, "Только Command Palette")
        )
      ),
      checkbox("Выполнять запросы панелей и передавать реальные результаты", "includePanelData", true),
      field("Максимум строк результата на панель", "maxPanelRows", "number"),
      field("Allowlist datasource UID через запятую (пусто = datasource текущего дашборда)", "allowedDatasourceUids"),
      h("label", { style: styles.field },
        h("span", null, "Минимальная роль пользователя (проверяется в браузере; прокси доступен с ролью Viewer)"),
        h("select", { style: styles.input, value: state.minimumRole || "Viewer", onChange: (event) => update({ minimumRole: event.target.value }) },
          h("option", { value: "Viewer" }, "Viewer"),
          h("option", { value: "Editor" }, "Editor"),
          h("option", { value: "Admin" }, "Admin")
        )
      ),
      h("label", { style: styles.field },
        h("span", null, "System prompt"),
        h("textarea", { style: Object.assign({}, styles.textarea, { minHeight: 120 }), value: state.systemPrompt || "", onChange: (event) => update({ systemPrompt: event.target.value }) })
      ),
      h("div", null, h("button", { type: "button", style: styles.button, onClick: save }, "Сохранить")),
      status ? h("div", null, status) : null
    );
  }

  function MainPage() {
    const content = h("div", { style: { height: "calc(100vh - 140px)", maxWidth: 1000, margin: "0 auto", padding: 16 } }, h(Assistant));
    return grafanaRuntime.PluginPage ? h(grafanaRuntime.PluginPage, { pageNav: { text: "AI Assistant" } }, content) : content;
  }

  // ---------- Плавающая кнопка и drawer ----------

  function themed(element) {
    const theme = grafanaRuntime.config && grafanaRuntime.config.theme2;
    return grafanaData.ThemeContext && theme ? h(grafanaData.ThemeContext.Provider, { value: theme }, element) : element;
  }

  // React 18 отдаёт createRoot из "react-dom"; в старых версиях есть только render. Если ни того, ни другого нет,
  // кнопка открывает штатный extension sidebar Grafana.
  function canMountReact() {
    return Boolean(ReactDOM && (typeof ReactDOM.createRoot === "function" || typeof ReactDOM.render === "function"));
  }

  function mountReact(container, element) {
    if (typeof ReactDOM.createRoot === "function") {
      const root = ReactDOM.createRoot(container);
      root.render(element);
      return () => root.unmount();
    }
    ReactDOM.render(element, container);
    return () => ReactDOM.unmountComponentAtNode(container);
  }

  function closeDrawer() {
    const drawer = document.getElementById("tech-ai-assistant-drawer");
    if (!drawer) return;
    if (typeof drawer.techAiUnmount === "function") drawer.techAiUnmount();
    drawer.remove();
  }

  function openDrawer() {
    if (!canMountReact()) {
      openAssistant();
      return;
    }
    const colors = themeColors();
    const drawer = document.createElement("aside");
    drawer.id = "tech-ai-assistant-drawer";
    Object.assign(drawer.style, {
      position: "fixed",
      top: "0",
      right: "0",
      zIndex: "2147483001",
      width: "min(560px, 100vw)",
      height: "100vh",
      display: "grid",
      gridTemplateRows: "48px minmax(0, 1fr)",
      background: colors.background,
      color: colors.text,
      borderLeft: `1px solid ${colors.border}`,
      boxShadow: "-8px 0 28px rgba(0,0,0,.45)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 12px 0 16px",
      fontWeight: "600",
      borderBottom: `1px solid ${colors.border}`,
    });
    header.appendChild(document.createTextNode(COMPONENT_TITLE));

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Закрыть (Esc)";
    Object.assign(close.style, { border: "0", background: "transparent", color: "inherit", fontSize: "28px", lineHeight: "36px", cursor: "pointer" });
    close.addEventListener("click", closeDrawer);
    header.appendChild(close);

    const content = document.createElement("div");
    content.id = "tech-ai-assistant-drawer-content";
    Object.assign(content.style, { minHeight: "0", padding: "12px", display: "flex", flexDirection: "column" });

    drawer.appendChild(header);
    drawer.appendChild(content);
    drawer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawer();
    });
    document.body.appendChild(drawer);
    drawer.techAiUnmount = mountReact(content, themed(h(Assistant)));
  }

  async function installLauncher() {
    if (new URLSearchParams(location.search).get("embed") === "1") return;
    if (document.getElementById("tech-ai-assistant-launcher")) return;
    try {
      cachedSettings = (await getSettings()).jsonData;
      localStorage.setItem("tech-ai-launcher-mode", cachedSettings.launcherMode || "both");
      assertAllowedRole(cachedSettings);
    } catch (_) {
      return;
    }
    if (configuredLauncherMode() === "commandPalette") return;
    const button = document.createElement("button");
    button.id = "tech-ai-assistant-launcher";
    button.type = "button";
    button.textContent = "AI";
    button.title = "Открыть Tech AI Assistant";
    Object.assign(button.style, {
      position: "fixed",
      right: "22px",
      bottom: "76px",
      zIndex: "2147483000",
      width: "52px",
      height: "52px",
      border: "0",
      borderRadius: "50%",
      background: "#ff9830",
      color: "#111217",
      fontSize: "18px",
      fontWeight: "700",
      boxShadow: "0 4px 14px rgba(0,0,0,.45)",
      cursor: "pointer",
    });
    button.addEventListener("click", () => {
      if (document.getElementById("tech-ai-assistant-drawer")) closeDrawer();
      else openDrawer();
    });
    document.body.appendChild(button);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installLauncher, { once: true });
    else installLauncher();
  }

  class OpenExtensionSidebarEvent extends grafanaData.BusEventWithPayload {}
  OpenExtensionSidebarEvent.type = "open-extension-sidebar";

  function openAssistant(initialContext) {
    grafanaRuntime.getAppEvents().publish(new OpenExtensionSidebarEvent({
      pluginId: PLUGIN_ID,
      componentTitle: COMPONENT_TITLE,
      props: { initialContext, initialAutoSend: false },
    }));
  }

  const plugin = new grafanaData.AppPlugin()
    .setRootPage(MainPage)
    .addConfigPage({ title: "Configuration", icon: "cog", body: ConfigPage, id: "configuration" })
    .addComponent({ targets: [SIDEBAR_TARGET], title: COMPONENT_TITLE, description: "AI Assistant with current Grafana context", component: Assistant })
    .addLink({ targets: [SIDEBAR_TARGET], title: COMPONENT_TITLE, description: "Open AI Assistant", icon: "ai-sparkle", onClick: () => openAssistant() })
    .addLink({
      targets: [COMMAND_PALETTE_TARGET],
      title: "Открыть Tech AI Assistant",
      description: "AI-анализ текущей страницы Grafana",
      icon: "ai-sparkle",
      configure: () => configuredLauncherMode() === "floating" ? undefined : {},
      onClick: (_event, helpers) => openAssistant(helpers && helpers.context),
    })
    .addLink({
      targets: [EXPLORE_TOOLBAR_TARGET],
      title: "Спросить AI",
      description: "Передать текущий контекст Explore в AI Assistant",
      icon: "ai-sparkle",
      onClick: (_event, helpers) => openAssistant(helpers && helpers.context),
    })
    .addLink({
      targets: [PANEL_MENU_TARGET],
      title: "Спросить AI",
      description: "Передать панель и её запросы AI Assistant",
      icon: "ai-sparkle",
      onClick: (_event, helpers) =>
        helpers.openModal({
          title: COMPONENT_TITLE,
          width: 760,
          height: 700,
          body: () => h("div", { style: { height: 620, display: "flex", flexDirection: "column" } }, h(Assistant, { initialContext: helpers.context })),
        }),
    });

  return {
    plugin,
    // Чистые функции для unit-тестов (test/unit.test.js); Grafana это поле игнорирует.
    __test: { splitThink, readEventStream, applyChoice, emptyAccumulator, parseTextToolCalls, parseDashboardProposal, flattenPanels, fitContext, planRequest, splitContent, sanitizeForAI, redactString, formatError, deepReplace, stepSummary, requestBody, exploreUrl, currentVariables, historyKey, proxyRoute, modelsRoute, shouldRetryWithoutStream },
  };
});
