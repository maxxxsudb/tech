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
    { label: "Подготовить алерт", needsPanel: true, prompt: "Подготовь черновик правила алерта по выбранной панели: запрос, условие, рекомендуемый порог, период оценки, время pending и описание. Объясни основания порога. Если фактических данных недостаточно, отметь это и спроси нужный порог. Не сохраняй алерт и не предлагай dashboard-json для создания правила." },
  ];
  return { turnAt, exportMarkdown, downloadMarkdown, playbooks };
});
