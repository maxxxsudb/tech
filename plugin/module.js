define(["@grafana/data", "@grafana/runtime", "react"], function (grafanaData, grafanaRuntime, React) {
  "use strict";

  const PLUGIN_ID = "tech-ai-assistant-app";
  const COMPONENT_TITLE = "Tech AI Assistant";
  const SIDEBAR_TARGET = "grafana/extension-sidebar/v0-alpha";
  const PANEL_MENU_TARGET = "grafana/dashboard/panel/menu";
  const COMMAND_PALETTE_TARGET = "grafana/commandpalette/action";
  const EXPLORE_TOOLBAR_TARGET = "grafana/explore/toolbar/action";
  const h = React.createElement;
  const defaults = {
    provider: "custom",
    apiUrl: "https://api.openai.com",
    apiPath: "/v1/chat/completions",
    model: "gpt-4.1-mini",
    groqModel: "qwen/qwen3.8-27b",
    useAuth: true,
    authScheme: "Bearer",
    reasoningEffort: "",
    maxTokens: 0,
    launcherMode: "both",
    includePanelData: true,
    maxPanelRows: 20,
    allowedDatasourceUids: "",
    minimumRole: "Viewer",
    systemPrompt:
      "Ты AI-ассистент внутри Grafana. Помогай с дашбордами, PromQL, LogQL, SQL, алертами и observability. Отвечай на языке пользователя. Формулу, которую можно вставить в Grafana, показывай первой.",
  };
  let cachedSettings = defaults;

  function configuredLauncherMode() {
    return localStorage.getItem("tech-ai-launcher-mode") || cachedSettings.launcherMode || "both";
  }

  const styles = {
    root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 420, gap: 12 },
    history: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 8 },
    user: { alignSelf: "flex-end", maxWidth: "90%", padding: "8px 12px", borderRadius: 6, background: "#1f60c4", color: "white", whiteSpace: "pre-wrap" },
    assistant: { alignSelf: "stretch", padding: "8px 12px", borderRadius: 6, background: "rgba(128,128,128,.12)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
    context: { color: "var(--text-secondary, #999)", fontSize: 12 },
    attachment: { color: "var(--text-secondary, #999)", fontSize: 12, marginTop: 4 },
    error: { padding: 10, border: "1px solid #e02f44", borderRadius: 4, color: "#e02f44" },
    composer: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" },
    textarea: { width: "100%", minHeight: 72, resize: "vertical", padding: 8, color: "inherit", background: "transparent", border: "1px solid rgba(128,128,128,.45)", borderRadius: 4 },
    button: { minHeight: 36, padding: "0 14px", cursor: "pointer" },
    quickActions: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 },
    quickButton: { minHeight: 30, padding: "0 9px", cursor: "pointer", borderRadius: 4 },
    proposal: { padding: 10, border: "1px solid #5794f2", borderRadius: 4, display: "grid", gap: 8 },
    diff: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
    pre: { maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11, padding: 8, background: "rgba(0,0,0,.25)" },
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
    const rawData = reason && reason.data;
    const data = Array.isArray(rawData) ? rawData[0] : rawData;
    const apiError = data && data.error;
    const status = reason && (reason.status || reason.statusCode);
    const code = apiError && apiError.code;
    const message =
      (apiError && apiError.message) ||
      (data && data.message) ||
      (reason && reason.message) ||
      (typeof reason === "string" ? reason : "Неизвестная ошибка");
    return [status ? `HTTP ${status}` : "", code || "", message].filter(Boolean).join(" · ");
  }

  async function getSettings() {
    const result = await grafanaRuntime.getBackendSrv().get(`/api/plugins/${PLUGIN_ID}/settings`);
    return {
      jsonData: Object.assign({}, defaults, result.jsonData || {}),
      secureJsonFields: result.secureJsonFields || {},
    };
  }

  function requestBody(settings, context, messages, investigation) {
    const patchContract =
      "Если предлагаешь изменить запрос существующей панели, дополнительно верни полный новый массив targets в блоке " +
      "```dashboard-json\\n{\"panelId\": 2, \"targets\": [...]}\\n```. " +
      "Не добавляй в этот блок другие поля и не меняй datasource без явной просьбы пользователя.";
    const body = {
      model: settings.provider === "groq" ? settings.groqModel : settings.model,
      stream: false,
      messages: [
        {
          role: "system",
          content: `${settings.systemPrompt || defaults.systemPrompt}\n${patchContract}\n\nТекущий контекст Grafana:\n${JSON.stringify(sanitizeForAI(context)).slice(0, 120000)}`,
        },
      ].concat(messages),
    };
    if (settings.reasoningEffort) body.reasoning_effort = settings.reasoningEffort;
    const maxTokens = Number(settings.maxTokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    if (investigation) {
      body.tools = [{
        type: "function",
        function: {
          name: "query_grafana_datasource",
          description: "Выполнить дополнительный read-only запрос к Loki, Prometheus или Tempo из текущего дашборда. Используй только для проверки конкретной гипотезы.",
          parameters: {
            type: "object",
            properties: {
              datasourceUid: { type: "string", description: "UID datasource из текущего контекста" },
              query: { type: "object", description: "Query JSON для Grafana datasource, например expr/refId для Loki или Prometheus" },
              reason: { type: "string", description: "Какую гипотезу проверяет запрос" },
            },
            required: ["datasourceUid", "query", "reason"],
          },
        },
      }];
      body.tool_choice = "auto";
    }
    return body;
  }

  function proxyRoute(settings) {
    if (settings.provider === "groq") return "groq-chat";
    return settings.useAuth ? "chat-auth" : "chat";
  }

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

  function datasourceUid(panel, target) {
    const datasource = (target && target.datasource) || panel.datasource || {};
    return typeof datasource === "string" ? datasource : datasource.uid;
  }

  function isDatasourceAllowed(settings, panel, target) {
    const allowlist = configuredDatasourceAllowlist(settings);
    return allowlist.size === 0 || allowlist.has(datasourceUid(panel, target));
  }

  function rangeMilliseconds(value, fallback) {
    try {
      const parsed = grafanaData.dateMath && grafanaData.dateMath.parse(value || fallback);
      if (parsed) return parsed.valueOf();
    } catch (_) {}
    return fallback === "now" ? Date.now() : Date.now() - 3600000;
  }

  function summarizeFrame(frame, maxRows) {
    const schema = frame && frame.schema ? frame.schema : {};
    const fields = Array.isArray(schema.fields) ? schema.fields : [];
    const values = frame && frame.data && Array.isArray(frame.data.values) ? frame.data.values : [];
    const rowCount = Math.min(maxRows, values.reduce((max, column) => Math.max(max, Array.isArray(column) ? column.length : 0), 0));
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
      fields: fields.map((field) => ({ name: field.name, type: field.type })),
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

  async function loadPanelData(settings, context) {
    if (settings.includePanelData === false) return [];
    const panels = context.panel ? [context.panel] : (context.panels || []).slice(0, 4);
    const maxRows = Math.max(1, Math.min(100, Number(settings.maxPanelRows) || 20));
    const from = rangeMilliseconds(context.timeRange && context.timeRange.from, "now-1h");
    const to = rangeMilliseconds(context.timeRange && context.timeRange.to, "now");
    return Promise.all(panels.map(async (panel) => {
      const targets = (panel.targets || []).filter((target) => isDatasourceAllowed(settings, panel, target)).slice(0, 4);
      if (!targets.length) return { panelId: panel.id, title: panel.title, skipped: "Datasource не входит в allowlist" };
      const queries = targets.map((target, index) => Object.assign({}, target, {
        refId: target.refId || String.fromCharCode(65 + index),
        datasource: target.datasource || panel.datasource,
        maxDataPoints: Math.min(Number(target.maxDataPoints) || 100, 500),
        intervalMs: Number(target.intervalMs) || 60000,
      }));
      try {
        const response = await grafanaRuntime.getBackendSrv().post("/api/ds/query", { from: String(from), to: String(to), queries });
        const results = response && response.results ? response.results : {};
        return {
          panelId: panel.id,
          title: panel.title,
          datasourceUid: datasourceUid(panel, queries[0]),
          queries: queries.map((query) => sanitizeForAI(query)),
          results: Object.keys(results).map((refId) => ({ refId, result: summarizeQueryResult(results[refId], maxRows) })),
        };
      } catch (reason) {
        return { panelId: panel.id, title: panel.title, datasourceUid: datasourceUid(panel, queries[0]), error: formatError(reason) };
      }
    }));
  }

  async function contextWithLiveData(settings, context) {
    const next = Object.assign({}, context);
    next.panelData = await loadPanelData(settings, context);
    return sanitizeForAI(next);
  }

  function contextDatasources(context) {
    const panels = context.panel ? [context.panel] : (context.panels || []);
    const result = new Map();
    panels.forEach((panel) => {
      [panel.datasource].concat((panel.targets || []).map((target) => target.datasource)).filter(Boolean).forEach((datasource) => {
        if (typeof datasource === "object" && datasource.uid) result.set(datasource.uid, { uid: datasource.uid, type: datasource.type });
      });
    });
    return result;
  }

  async function executeInvestigationTool(settings, context, toolCall) {
    let args;
    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch (_) {
      throw new Error("Модель вернула некорректные аргументы инструмента");
    }
    const sources = contextDatasources(context);
    const source = sources.get(args.datasourceUid);
    if (!source) throw new Error(`Datasource ${args.datasourceUid} отсутствует в текущем дашборде`);
    if (!new Set(["loki", "prometheus", "tempo"]).has(source.type)) throw new Error(`Дополнительные запросы к ${source.type} запрещены`);
    if (!isDatasourceAllowed(settings, { datasource: source }, { datasource: source })) throw new Error(`Datasource ${source.uid} не входит в allowlist`);
    if (!args.query || typeof args.query !== "object" || Array.isArray(args.query)) throw new Error("Query должен быть объектом");
    const from = rangeMilliseconds(context.timeRange && context.timeRange.from, "now-1h");
    const to = rangeMilliseconds(context.timeRange && context.timeRange.to, "now");
    const query = Object.assign({}, args.query, {
      datasource: source,
      refId: args.query.refId || "AI",
      maxDataPoints: Math.min(Number(args.query.maxDataPoints) || 100, 500),
      intervalMs: Number(args.query.intervalMs) || 60000,
    });
    const response = await grafanaRuntime.getBackendSrv().post("/api/ds/query", { from: String(from), to: String(to), queries: [query] });
    const results = response && response.results ? response.results : {};
    return sanitizeForAI({
      reason: args.reason,
      datasource: source,
      query,
      results: Object.keys(results).map((refId) => ({ refId, result: summarizeQueryResult(results[refId], Math.max(1, Math.min(100, Number(settings.maxPanelRows) || 20))) })),
    });
  }

  async function callAssistant(settings, context, messages, investigation) {
    const route = proxyRoute(settings);
    if (settings.provider !== "groq") normalizePath(settings.apiPath);
    let conversation = messages.slice();
    for (let iteration = 0; iteration < (investigation ? 3 : 1); iteration += 1) {
      const response = await grafanaRuntime.getBackendSrv().post(
        `/api/plugin-proxy/${PLUGIN_ID}/${route}`,
        requestBody(settings, context, conversation, investigation)
      );
      const message = response && response.choices && response.choices[0] && response.choices[0].message;
      if (!message) throw new Error("Провайдер вернул ответ без choices[0].message");
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 3) : [];
      if (!investigation || !toolCalls.length) return response;
      conversation.push(message);
      for (const toolCall of toolCalls) {
        let result;
        try {
          result = await executeInvestigationTool(settings, context, toolCall);
        } catch (reason) {
          result = { error: formatError(reason) };
        }
        conversation.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result).slice(0, 30000) });
      }
    }
    throw new Error("Расследование превысило лимит дополнительных запросов");
  }

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

  function panelForProposal(context, proposal) {
    const panels = context.panel ? [context.panel] : (context.panels || []);
    return panels.find((panel) => Number(panel.id) === Number(proposal.panelId));
  }

  async function applyDashboardProposal(settings, context, proposal) {
    if (!context.dashboardUid) throw new Error("Изменение возможно только для сохранённого дашборда");
    const response = await grafanaRuntime.getBackendSrv().get(`/api/dashboards/uid/${encodeURIComponent(context.dashboardUid)}`);
    if (response.meta && response.meta.canSave === false) throw new Error("У пользователя нет права сохранять этот дашборд");
    const dashboard = response.dashboard;
    const panel = (dashboard.panels || []).find((item) => Number(item.id) === Number(proposal.panelId));
    if (!panel) throw new Error(`Панель ${proposal.panelId} не найдена`);
    const existingUids = new Set((panel.targets || []).map((target) => datasourceUid(panel, target)).filter(Boolean));
    proposal.targets.forEach((target) => {
      const uid = datasourceUid(panel, target);
      if (uid && !existingUids.has(uid)) throw new Error(`AI попытался заменить datasource на ${uid}; изменение заблокировано`);
      if (!isDatasourceAllowed(settings, panel, target)) throw new Error(`Datasource ${uid} не входит в allowlist`);
    });
    panel.targets = proposal.targets;
    await grafanaRuntime.getBackendSrv().post("/api/dashboards/db", {
      dashboard,
      folderUid: response.meta && response.meta.folderUid,
      overwrite: true,
      message: "Tech AI Assistant: update panel queries",
    });
  }

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
    { label: "Расследовать", investigation: true, prompt: "Проведи расследование по текущему диапазону времени. Сопоставь фактические результаты панелей, при необходимости выполни дополнительные read-only запросы, сформируй гипотезы, доказательства, исходные запросы и следующие проверки. Не выдавай гипотезы за факты." },
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

  function dashboardUid() {
    const explicitUid = new URLSearchParams(location.search).get("dashboardUid");
    if (explicitUid) return explicitUid;
    const subPath = grafanaRuntime.config.appSubUrl || "";
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
      const number = Number(candidate);
      if (Number.isFinite(number) && number > 0) return number;
    }
    return undefined;
  }

  function summarizePanel(panel) {
    return {
      id: panel.id,
      title: panel.title,
      type: panel.type,
      datasource: panel.datasource,
      targets: panel.targets,
      transformations: panel.transformations,
      fieldConfig: panel.fieldConfig,
    };
  }

  async function loadContext(extensionContext) {
    const params = new URLSearchParams(location.search);
    const variables = {};
    params.forEach((value, key) => {
      if (key.startsWith("var-")) variables[key.slice(4)] = value;
    });
    const uid = dashboardUid();
    const context = {
      pageUrl: location.href,
      appSubUrl: grafanaRuntime.config.appSubUrl || "",
      dashboardUid: uid,
      timeRange: { from: params.get("from"), to: params.get("to"), timezone: params.get("timezone") },
      variables,
      extension: primitiveContext(extensionContext),
    };
    if (!uid) return context;

    const response = await grafanaRuntime.getBackendSrv().get(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
    const dashboard = response && response.dashboard;
    if (!dashboard) return context;
    context.dashboardTitle = dashboard.title;
    context.tags = dashboard.tags;
    const panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
    const selectedId = panelId(extensionContext);
    const selected = panels.find((item) => Number(item.id) === selectedId);
    if (selected) context.panel = summarizePanel(selected);
    else context.panels = panels.map(summarizePanel);
    return context;
  }

  function Assistant(props) {
    props = props || {};
    const [settings, setSettings] = React.useState();
    const [context, setContext] = React.useState();
    const [history, setHistory] = React.useState([]);
    const [input, setInput] = React.useState(props.initialPrompt || "");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [includeScreenshot, setIncludeScreenshot] = React.useState(false);
    const historyRef = React.useRef(null);
    const rootRef = React.useRef(null);

    React.useEffect(() => {
      Promise.all([getSettings(), loadContext(props.initialContext)])
        .then(([nextSettings, nextContext]) => {
          setSettings(nextSettings.jsonData);
          setContext(nextContext);
        })
        .catch((reason) => setError(`Не удалось загрузить настройки или контекст: ${formatError(reason)}`));
    }, [props.initialContext]);

    React.useEffect(() => {
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }, [history]);

    async function send(promptOverride, action) {
      const prompt = String(promptOverride || input).trim();
      if (!prompt || busy || !settings || !context) return;
      setBusy(true);
      setError("");
      try {
        assertAllowedRole(settings);
        const screenshot = includeScreenshot ? await captureDashboardScreenshot(rootRef.current) : undefined;
        const requestContext = await contextWithLiveData(settings, context);
        setInput("");
        const messages = history.concat([{ role: "user", content: prompt + screenshotNote(screenshot) + panelDataNote(requestContext) }]);
        const apiMessages = history.concat([{ role: "user", content: imageMessage(prompt, screenshot) }]);
        setHistory(messages.concat([{ role: "assistant", content: "…" }]));
        const response = await callAssistant(settings, requestContext, apiMessages, Boolean(action && action.investigation));
        const content = response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
        if (!content) throw new Error("Провайдер вернул ответ без choices[0].message.content");
        setHistory(messages.concat([{ role: "assistant", content }]));
      } catch (reason) {
        setHistory((current) => current.filter((message) => message.content !== "…"));
        setError(formatError(reason));
      } finally {
        setBusy(false);
      }
    }

    function proposalCard(message, index) {
      const proposal = parseDashboardProposal(message.content);
      if (!proposal) return null;
      const panel = panelForProposal(context, proposal);
      return h("div", { key: `proposal-${index}`, style: styles.proposal },
        h("strong", null, `Предложение для панели ${proposal.panelId}`),
        h("div", { style: styles.diff },
          h("div", null, h("div", { style: styles.context }, "Было"), h("pre", { style: styles.pre }, JSON.stringify((panel && panel.targets) || [], null, 2))),
          h("div", null, h("div", { style: styles.context }, "Станет"), h("pre", { style: styles.pre }, JSON.stringify(proposal.targets, null, 2)))
        ),
        h("div", { style: styles.quickActions },
          h("button", { style: styles.button, onClick: () => navigator.clipboard.writeText(JSON.stringify(proposal, null, 2)) }, "Копировать JSON"),
          h("button", {
            style: styles.button,
            onClick: async () => {
              if (!window.confirm(`Применить новые targets к панели ${proposal.panelId}?`)) return;
              try {
                await applyDashboardProposal(settings, context, proposal);
                window.location.reload();
              } catch (reason) {
                setError(formatError(reason));
              }
            },
          }, "Применить к дашборду")
        )
      );
    }

    return h("div", { style: styles.root, ref: rootRef },
      h("div", { style: styles.context }, context ? `${context.dashboardTitle || "Текущая страница Grafana"}${context.panel ? ` · ${context.panel.title}` : ""}` : "Загрузка контекста…"),
      error ? h("div", { style: styles.error }, error) : null,
      h("div", { style: styles.history, ref: historyRef },
        history.length === 0 ? h("div", { style: styles.context }, "Задайте вопрос по текущему дашборду или панели.") : null,
        history.map((message, index) => h(React.Fragment, { key: index },
          h("div", { style: message.role === "user" ? styles.user : styles.assistant }, message.content),
          message.role === "assistant" ? proposalCard(message, index) : null
        ))
      ),
      h("div", null,
        h("div", { style: styles.quickActions }, quickPrompts.map((action) =>
          h("button", { key: action.label, style: styles.quickButton, disabled: busy || !settings || !context, onClick: () => send(action.prompt, action) }, action.label)
        )),
        h("label", { style: Object.assign({}, styles.attachment, { display: "block", marginBottom: 6 }) },
          h("input", { type: "checkbox", checked: includeScreenshot, disabled: busy, onChange: (event) => setIncludeScreenshot(event.target.checked) }),
          " Сделать и отправить снимок дашборда для анализа"
        ),
        h("div", { style: styles.composer },
          h("textarea", {
            style: styles.textarea,
            value: input,
            disabled: busy || !settings || !context,
            placeholder: "Например: исправь PromQL этой панели",
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            },
          }),
          h("button", { style: styles.button, disabled: busy || !input.trim(), onClick: () => send() }, busy ? "Ждите…" : "Отправить")
        )
      )
    );
  }

  function ConfigPage() {
    const [state, setState] = React.useState(defaults);
    const [apiKey, setApiKey] = React.useState("");
    const [groqApiKey, setGroqApiKey] = React.useState("");
    const [keyIsSet, setKeyIsSet] = React.useState(false);
    const [groqKeyIsSet, setGroqKeyIsSet] = React.useState(false);
    const [status, setStatus] = React.useState("");

    React.useEffect(() => {
      getSettings()
        .then((settings) => {
          setState(settings.jsonData);
          setKeyIsSet(Boolean(settings.secureJsonFields.apiKey));
          setGroqKeyIsSet(Boolean(settings.secureJsonFields.groqApiKey));
        })
        .catch((reason) => setStatus(formatError(reason)));
    }, []);

    function field(label, key, type) {
      return h("label", { style: styles.field },
        h("span", null, label),
        h("input", {
          style: styles.input,
          type: type || "text",
          value: state[key] == null ? "" : state[key],
          onChange: (event) => setState(Object.assign({}, state, { [key]: event.target.value })),
        })
      );
    }

    async function save() {
      setStatus("Сохранение…");
      try {
        const data = { enabled: true, pinned: true, jsonData: state };
        if (apiKey || groqApiKey) data.secureJsonData = Object.assign({}, apiKey ? { apiKey } : {}, groqApiKey ? { groqApiKey } : {});
        await grafanaRuntime.getBackendSrv().post(`/api/plugins/${PLUGIN_ID}/settings`, data);
        cachedSettings = Object.assign({}, defaults, state);
        localStorage.setItem("tech-ai-launcher-mode", state.launcherMode || "both");
        setApiKey("");
        setGroqApiKey("");
        if (apiKey) setKeyIsSet(true);
        if (groqApiKey) setGroqKeyIsSet(true);
        setStatus("Сохранено. Для изменения способа запуска обновите страницу Grafana.");
      } catch (reason) {
        setStatus(formatError(reason));
      }
    }

    return h("div", { style: styles.config },
      h("h2", null, "Tech AI Assistant"),
      h("label", { style: styles.field },
        h("span", null, "Provider"),
        h("select", { style: styles.input, value: state.provider || "custom", onChange: (event) => setState(Object.assign({}, state, { provider: event.target.value })) },
          h("option", { value: "custom" }, "Custom / Gemini / OpenAI-compatible"),
          h("option", { value: "groq" }, "Groq Free")
        )
      ),
      state.provider === "groq"
        ? h(React.Fragment, null,
            h("div", { style: styles.context }, "Endpoint: https://api.groq.com/openai/v1/chat/completions"),
            field("Groq model", "groqModel"),
            h("label", { style: styles.field },
              h("span", null, `Groq API key${groqKeyIsSet ? " (уже сохранён)" : ""}`),
              h("input", { style: styles.input, type: "password", value: groqApiKey, placeholder: groqKeyIsSet ? "Оставьте пустым, чтобы не менять" : "gsk_…", onChange: (event) => setGroqApiKey(event.target.value) })
            )
          )
        : h(React.Fragment, null,
            field("API URL", "apiUrl"),
            field("Chat completions path", "apiPath"),
            field("Model", "model"),
            h("label", { style: styles.field },
              h("span", null, `API key${keyIsSet ? " (уже сохранён)" : ""}`),
              h("input", { style: styles.input, type: "password", value: apiKey, placeholder: keyIsSet ? "Оставьте пустым, чтобы не менять" : "", onChange: (event) => setApiKey(event.target.value) })
            ),
            h("label", null,
              h("input", { type: "checkbox", checked: Boolean(state.useAuth), onChange: (event) => setState(Object.assign({}, state, { useAuth: event.target.checked })) }),
              " Передавать Authorization header"
            ),
            field("Authorization scheme", "authScheme")
          ),
      field("Reasoning effort (optional)", "reasoningEffort"),
      field("Max output tokens (0 = provider default)", "maxTokens", "number"),
      h("label", { style: styles.field },
        h("span", null, "Способ запуска"),
        h("select", { style: styles.input, value: state.launcherMode || "both", onChange: (event) => setState(Object.assign({}, state, { launcherMode: event.target.value })) },
          h("option", { value: "both" }, "Кнопка AI и Command Palette"),
          h("option", { value: "floating" }, "Только кнопка AI"),
          h("option", { value: "commandPalette" }, "Только Command Palette")
        )
      ),
      h("label", null,
        h("input", { type: "checkbox", checked: state.includePanelData !== false, onChange: (event) => setState(Object.assign({}, state, { includePanelData: event.target.checked })) }),
        " Выполнять запросы панелей и передавать реальные результаты"
      ),
      field("Максимум строк результата на панель", "maxPanelRows", "number"),
      field("Allowlist datasource UID через запятую (пусто = datasource текущего дашборда)", "allowedDatasourceUids"),
      h("label", { style: styles.field },
        h("span", null, "Минимальная роль пользователя"),
        h("select", { style: styles.input, value: state.minimumRole || "Viewer", onChange: (event) => setState(Object.assign({}, state, { minimumRole: event.target.value })) },
          h("option", { value: "Viewer" }, "Viewer"),
          h("option", { value: "Editor" }, "Editor"),
          h("option", { value: "Admin" }, "Admin")
        )
      ),
      h("label", { style: styles.field },
        h("span", null, "System prompt"),
        h("textarea", { style: Object.assign({}, styles.textarea, { minHeight: 120 }), value: state.systemPrompt || "", onChange: (event) => setState(Object.assign({}, state, { systemPrompt: event.target.value })) })
      ),
      h("div", null, h("button", { style: styles.button, onClick: save }, "Сохранить")),
      status ? h("div", null, status) : null
    );
  }

  function MainPage() {
    const content = h("div", { style: { height: "calc(100vh - 140px)", maxWidth: 1000, margin: "0 auto", padding: 16 } }, h(Assistant));
    return grafanaRuntime.PluginPage ? h(grafanaRuntime.PluginPage, { pageNav: { text: "AI Assistant" } }, content) : content;
  }

  async function mountDrawerAssistant(container) {
    Object.assign(container.style, { display: "grid", gridTemplateRows: "auto auto 1fr auto", gap: "10px", padding: "12px", minHeight: "0" });
    const contextLine = document.createElement("div");
    Object.assign(contextLine.style, styles.context);
    contextLine.textContent = "Загрузка контекста…";
    const history = document.createElement("div");
    Object.assign(history.style, styles.history);
    const empty = document.createElement("div");
    Object.assign(empty.style, styles.context);
    empty.textContent = "Задайте вопрос по текущему дашборду.";
    history.appendChild(empty);
    const payloadDetails = document.createElement("details");
    payloadDetails.hidden = true;
    const payloadSummary = document.createElement("summary");
    payloadSummary.textContent = "Последний отправленный контекст";
    payloadSummary.style.cursor = "pointer";
    const payloadPre = document.createElement("pre");
    Object.assign(payloadPre.style, styles.pre);
    payloadDetails.appendChild(payloadSummary);
    payloadDetails.appendChild(payloadPre);
    const footer = document.createElement("div");
    const quickActions = document.createElement("div");
    Object.assign(quickActions.style, styles.quickActions);
    const screenshotLabel = document.createElement("label");
    Object.assign(screenshotLabel.style, styles.attachment, { display: "block", marginBottom: "6px" });
    const screenshotCheckbox = document.createElement("input");
    screenshotCheckbox.type = "checkbox";
    screenshotLabel.appendChild(screenshotCheckbox);
    screenshotLabel.appendChild(document.createTextNode(" Сделать и отправить снимок дашборда для анализа"));
    const composer = document.createElement("div");
    Object.assign(composer.style, styles.composer);
    const textarea = document.createElement("textarea");
    Object.assign(textarea.style, styles.textarea);
    textarea.placeholder = "Например: исправь PromQL этой панели";
    textarea.disabled = true;
    const sendButton = document.createElement("button");
    Object.assign(sendButton.style, styles.button);
    sendButton.textContent = "Отправить";
    sendButton.disabled = true;
    composer.appendChild(textarea);
    composer.appendChild(sendButton);
    footer.appendChild(screenshotLabel);
    footer.appendChild(composer);
    container.appendChild(contextLine);
    container.appendChild(payloadDetails);
    container.appendChild(history);
    container.appendChild(footer);

    let settings;
    let context;
    try {
      const loaded = await Promise.all([getSettings(), loadContext()]);
      settings = loaded[0].jsonData;
      context = loaded[1];
      contextLine.textContent = `${context.dashboardTitle || "Текущая страница Grafana"} · UID: ${context.dashboardUid || "—"}`;
      textarea.disabled = false;
      sendButton.disabled = false;
    } catch (reason) {
      contextLine.textContent = `Ошибка загрузки контекста: ${formatError(reason)}`;
      contextLine.style.color = "#e02f44";
      return;
    }

    function addMessage(role, content) {
      if (empty.isConnected) empty.remove();
      const message = document.createElement("div");
      Object.assign(message.style, role === "user" ? styles.user : styles.assistant);
      message.textContent = content;
      history.appendChild(message);
      history.scrollTop = history.scrollHeight;
      return message;
    }

    function addProposalCard(content) {
      const proposal = parseDashboardProposal(content);
      if (!proposal) return;
      const panel = panelForProposal(context, proposal);
      const card = document.createElement("div");
      Object.assign(card.style, styles.proposal);
      const title = document.createElement("strong");
      title.textContent = `Предложение для панели ${proposal.panelId}`;
      const diff = document.createElement("div");
      Object.assign(diff.style, styles.diff);
      [["Было", (panel && panel.targets) || []], ["Станет", proposal.targets]].forEach(([label, value]) => {
        const side = document.createElement("div");
        const caption = document.createElement("div");
        Object.assign(caption.style, styles.context);
        caption.textContent = label;
        const pre = document.createElement("pre");
        Object.assign(pre.style, styles.pre);
        pre.textContent = JSON.stringify(value, null, 2);
        side.appendChild(caption);
        side.appendChild(pre);
        diff.appendChild(side);
      });
      const apply = document.createElement("button");
      Object.assign(apply.style, styles.button);
      apply.textContent = "Применить к дашборду";
      apply.addEventListener("click", async () => {
        if (!window.confirm(`Применить новые targets к панели ${proposal.panelId}?`)) return;
        apply.disabled = true;
        try {
          await applyDashboardProposal(settings, context, proposal);
          window.location.reload();
        } catch (reason) {
          apply.disabled = false;
          const message = addMessage("assistant", `Ошибка применения: ${formatError(reason)}`);
          message.style.color = "#e02f44";
        }
      });
      const actions = document.createElement("div");
      Object.assign(actions.style, styles.quickActions);
      const copy = document.createElement("button");
      Object.assign(copy.style, styles.button);
      copy.textContent = "Копировать JSON";
      copy.addEventListener("click", () => navigator.clipboard.writeText(JSON.stringify(proposal, null, 2)));
      actions.appendChild(copy);
      actions.appendChild(apply);
      card.appendChild(title);
      card.appendChild(diff);
      card.appendChild(actions);
      history.appendChild(card);
      history.scrollTop = history.scrollHeight;
    }

    async function send(promptOverride, action) {
      const prompt = String(promptOverride || textarea.value).trim();
      if (!prompt || sendButton.disabled) return;
      textarea.value = "";
      textarea.disabled = true;
      sendButton.disabled = true;
      screenshotCheckbox.disabled = true;
      let pending;
      try {
        assertAllowedRole(settings);
        const screenshot = screenshotCheckbox.checked ? await captureDashboardScreenshot(container) : undefined;
        const requestContext = await contextWithLiveData(settings, context);
        payloadPre.textContent = JSON.stringify(requestContext, null, 2);
        payloadDetails.hidden = false;
        addMessage("user", prompt + screenshotNote(screenshot) + panelDataNote(requestContext));
        pending = addMessage("assistant", "…");
        const response = await callAssistant(settings, requestContext, [{ role: "user", content: imageMessage(prompt, screenshot) }], Boolean(action && action.investigation));
        const content = response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
        if (!content) throw new Error("Провайдер вернул ответ без choices[0].message.content");
        pending.textContent = content;
        addProposalCard(content);
      } catch (reason) {
        const errorMessage = pending || addMessage("assistant", "");
        errorMessage.textContent = `Ошибка: ${formatError(reason)}`;
        errorMessage.style.color = "#e02f44";
      } finally {
        textarea.disabled = false;
        sendButton.disabled = false;
        screenshotCheckbox.disabled = false;
        textarea.focus();
      }
    }

    quickPrompts.forEach((action) => {
      const button = document.createElement("button");
      Object.assign(button.style, styles.quickButton);
      button.textContent = action.label;
      button.addEventListener("click", () => send(action.prompt, action));
      quickActions.appendChild(button);
    });
    footer.insertBefore(quickActions, screenshotLabel);

    sendButton.addEventListener("click", () => send());
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
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
      const existing = document.getElementById("tech-ai-assistant-drawer");
      if (existing) {
        existing.remove();
        return;
      }
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
        gridTemplateRows: "48px 1fr",
        background: "#111217",
        borderLeft: "1px solid #34373d",
        boxShadow: "-8px 0 28px rgba(0,0,0,.45)",
      });

      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 12px 0 16px",
        color: "#f4f5f5",
        fontWeight: "600",
        borderBottom: "1px solid #34373d",
      });
      header.appendChild(document.createTextNode(COMPONENT_TITLE));

      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.title = "Закрыть";
      Object.assign(close.style, {
        border: "0",
        background: "transparent",
        color: "#f4f5f5",
        fontSize: "28px",
        lineHeight: "36px",
        cursor: "pointer",
      });
      close.addEventListener("click", () => drawer.remove());
      header.appendChild(close);

      const content = document.createElement("div");
      content.id = "tech-ai-assistant-drawer-content";
      content.style.minHeight = "0";

      drawer.appendChild(header);
      drawer.appendChild(content);
      document.body.appendChild(drawer);
      mountDrawerAssistant(content);
    });
    document.body.appendChild(button);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installLauncher, { once: true });
  else installLauncher();

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
          body: () => h(Assistant, { initialContext: helpers.context }),
        }),
    });

  return { plugin };
});
