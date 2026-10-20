(function (factory) {
  if (typeof define === "function") define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
})(function () {
  "use strict";

  function turnAt(history, index) {
    for (let i = Math.min(index, history.length - 1); i >= 0; i--) {
      if (history[i].role === "user") return { index: i, message: history[i], history: history.slice(0, i) };
    }
  }

  function exportMarkdown(history, context, lastRequest) {
    context = context || {};
    const panels = context.panel ? [context.panel] : context.panels || [];
    const range = (lastRequest && lastRequest.dataRange) || context.timeRange || {};
    const lines = ["# " + (context.dashboardTitle || "Диалог Grafana"), "", "Дашборд: " + (context.pageUrl || context.dashboardUid || "не указан"), "", "Диапазон: " + (range.from || "—") + " — " + (range.to || "—"), "", "## Панели и запросы", ""];
    panels.forEach((panel) => {
      lines.push("### #" + panel.id + " " + (panel.title || "Без названия"), "");
      (panel.targets || []).forEach((target) => {
        const query = target.expr || target.query || target.rawSql;
        if (typeof query === "string") lines.push("Запрос " + (target.refId || "A") + ":", "", "```text", query, "```", "");
      });
    });
    lines.push("## Диалог", "");
    history.forEach((message) => {
      lines.push("### " + (message.role === "user" ? "Пользователь" : "Ассистент"), "", message.content, "");
      if (message.note) lines.push(message.note, "");
      if (message.failed) lines.push("_Ответ не получен._", "");
      (message.attachments || []).forEach((item) => lines.push("Вложение: " + item.name + " (" + item.kind + ", " + item.bytes + " байт)", ""));
    });
    if (lastRequest && lastRequest.usage) lines.push("Токены последнего запроса, все раунды: вход " + lastRequest.usage.prompt + ", выход " + lastRequest.usage.completion, "");
    return lines.join("\n");
  }

  function downloadMarkdown(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = String(name || "grafana-dialog").replace(/[^\p{L}\p{N}._-]+/gu, "-") + ".md";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const playbooks = [
    { label: "Почему нет данных?", sampleData: true, prompt: "Проверь выбранные панели: datasource, переменные, диапазон времени, фильтры и запросы. Объясни наиболее вероятные причины отсутствия данных и предложи конкретные проверки. Не выдавай отсутствие выборки в контексте за отсутствие данных в datasource." },
    { label: "Написать запрос", needsPanel: true, prompt: "Помоги написать запрос для выбранной панели. Используй её datasource, формат и переменные. Если цель запроса не указана, сначала задай один короткий вопрос. Не выдумывай метрики, таблицы и поля, которых нет в контексте." },
    { label: "Сравнить периоды", investigation: true, comparePeriods: true, prompt: "Сравни фактические данные текущего подтверждённого периода с предшествующим периодом той же длительности из comparisonPanelData. Покажи изменения, пики и ограничения выборки. Сопоставляй одинаковые панели и серии. Не выдумывай отсутствующие данные." },
    { label: "Подготовить алерт", needsPanel: true, alertDraft: true, prompt: "Подготовь черновик правила алерта по выбранной панели. Не сохраняй алерт без явного подтверждения." },
    { label: "Проверить SQL-алерт", needsPanel: true, investigation: true, prompt: "Проверь SQL выбранной панели/алерта: реальный PostgreSQL datasource, timeFilter и окно, типы time/value, NULL и пустой результат, агрегацию и dimensions. Отдели NoData/Error от ложного условия. Используй только полученные evidence и разрешённые read-only инструменты; не делай скрытых запросов, не меняй правило. Если схема неизвестна, предложи подтверждённую разведку." },
    { label: "Разобрать ошибку PostgreSQL", needsPanel: true, investigation: true, prompt: "Разбери фактическую ошибку PostgreSQL/SQLSTATE выбранного запроса. Не угадывай таблицы/колонки: при разрешённой разведке уточни schema/columns и предложи минимальную правку SELECT. После 42501 не обходи права. LIMIT не ограничивает scan, EXPLAIN ANALYZE не выполняй. Если ошибки в evidence нет, попроси её текст; не выдумывай." },
    { label: "Сравнить SQL-периоды", needsPanel: true, investigation: true, comparePeriods: true, prompt: "Сравни текущий и предыдущий подтверждённые периоды SQL-панели по panelData/comparisonPanelData: одинаковые окна, series/labels, NULL/NoData/Error, уровни и пики. Покажи фактические различия и ограничения. Не считай отсутствующие строки нулём. Не меняй SQL/алерты и не утверждай причину по одной корреляции." },
  ];
  function customPrompts(value, reserved) {
    if (value === undefined || value === "") return [];
    const values = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(values) || values.length > 12) throw Error("Командные сценарии: массив до 12 элементов");
    const seen = new Set(playbooks.map(item => item.label).concat(reserved || []));
    return values.map(item => {
      if (!item || typeof item.label !== "string" || !item.label.trim() || item.label.length > 60 || typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 6000) throw Error("Сценарий: нужны label (до 60) и prompt (до 6000)");
      if (seen.has(item.label.trim())) throw Error("Повторное имя сценария: " + item.label); seen.add(item.label.trim());
      const result = { label: item.label.trim(), prompt: item.prompt.trim() };
      for (const key of ["needsPanel", "sampleData", "investigation", "comparePeriods"]) { if (item[key] !== undefined && typeof item[key] !== "boolean") throw Error(key + " должен быть boolean"); if (item[key] !== undefined) result[key] = item[key]; }
      if (Object.keys(item).some(key => !["label", "prompt", "needsPanel", "sampleData", "investigation", "comparePeriods"].includes(key))) throw Error("Неизвестное поле сценария");
      if (result.comparePeriods) result.investigation = true;
      return result;
    });
  }

  function caseScope(orgId, userId, instance) {
    if (!orgId || !userId) throw Error("Не получена организация/пользователь: постоянное хранение недоступно");
    return "tech-ai-assistant:cases:v1:" + encodeURIComponent(instance || "") + ":" + encodeURIComponent(orgId) + ":" + encodeURIComponent(userId);
  }
  function cleanCase(value) {
    const clean = (input, depth) => {
      if (depth > 18) throw Error("Слишком глубокий кейс");
      if (typeof input === "string") return input.replace(/data:[^\s]*;base64,[a-zA-Z0-9+/=\s]+/gi, "[IMAGE OMITTED]");
      if (!input || typeof input !== "object") return input;
      if (Array.isArray(input)) return input.slice(0, 100).map(item => clean(item, depth + 1));
      return Object.fromEntries(Object.entries(input).filter(([key]) => !/^(?:images?|dataUrl|base64|attachments|charts|modelContent|reasoning|action|__proto__|constructor|prototype)$/i.test(key)).map(([key, child]) => [key, /password|passwd|secret|token|api.?key|authorization|cookie/i.test(key) ? "[REDACTED]" : clean(child, depth + 1)]));
    };
    const result = clean(value, 0);
    if (!result || result.schemaVersion !== 1 || typeof result.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(result.id) || typeof result.title !== "string" || !result.title.trim() || result.title.length > 160 || !Number.isFinite(Date.parse(result.updatedAt))) throw Error("Некорректный формат кейса");
    if (!Array.isArray(result.messages) || result.messages.length > 40 || result.messages.some(item => !["user", "assistant"].includes(item.role) || typeof item.content !== "string")) throw Error("Некорректный диалог кейса");
    if (new TextEncoder().encode(JSON.stringify(result)).length > 200000) throw Error("Кейс превышает 200 КБ: сократите диалог/evidence");
    return result;
  }
  function readCases(storage, key) {
    const values = JSON.parse(storage.getItem(key) || "[]");
    if (!Array.isArray(values) || values.length > 20) throw Error("Некорректное хранилище кейсов");
    return values.map(cleanCase);
  }
  function storeCase(storage, key, record, enabled) {
    if (!enabled) throw Error("Разрешите локальное сохранение; без согласия записи нет");
    const item = cleanCase(record), values = readCases(storage, key).filter(value => value.id !== item.id);
    if (values.length >= 20) throw Error("Лимит 20 кейсов: удалите старый или экспортируйте");
    values.unshift(item); const text = JSON.stringify(values); if (new TextEncoder().encode(text).length > 2000000) throw Error("Лимит хранилища 2 МБ"); storage.setItem(key, text); return values;
  }
  function removeCase(storage, key, id) { const values = readCases(storage, key).filter(value => value.id !== id); storage.setItem(key, JSON.stringify(values)); return values; }
  function caseCompatible(record, context) {
    const alertUid = context.alerting?.ruleUid;
    return record.context?.dashboardUid === context.dashboardUid && (record.context?.alertUid || undefined) === alertUid && (record.context?.panelId || undefined) === (context.panel?.id || undefined) && (record.context?.pageType || "dashboard") === (context.isAlerting ? "alerting" : context.isExplore ? "explore" : "dashboard") && (!context.isExplore || record.context?.pageUrl === context.pageUrl);
  }
  return { turnAt, exportMarkdown, downloadMarkdown, playbooks, customPrompts, caseScope, cleanCase, readCases, storeCase, removeCase, caseCompatible };
});
