# Кнопка AI не открывает панель в Grafana 13.2.2

2026-10-15. Первичная диагностика версии плагина 0.9.2 выполнена без изменения production-кода. Исправление затем выпущено в 0.9.3.

## Установленная цепочка

1. `plugin/module.js` импортирует `react-dom`, не `react-dom/client`.
2. `canMountReact()` проверяет только `ReactDOM.createRoot` и `ReactDOM.render`.
3. В Grafana 13.0.2 зависимости React/ReactDOM — 18.3.1, в 13.2.2 — 19.2.8. В React 19 `createRoot` находится в `react-dom/client`, legacy `render` удалён.
4. При отсутствии обоих методов оранжевая кнопка через `openDrawer()` вызывает `openAssistant()`: публикацию `open-extension-sidebar`.
5. Штатный `ExtensionSidebarProvider` допускает только `PERMITTED_EXTENSION_SIDEBAR_PLUGINS`. `tech-ai-assistant-app` в списке нет, событие игнорируется без сообщения.

Allowlist есть и в 13.0.2: это не новое ограничение 13.2.2. Раньше резервная ветка не срабатывала при открытии плавающей кнопкой благодаря React 18.

Изолированное воспроизведение на текущем production-модуле: импорт `react-dom` без методов монтирования, нажатие обработчика настоящей кнопки → drawer не создан, опубликовано одно событие для запрещённого ID. Исправления в тестовый production-код не вносились.

## Требуемое исправление

Явно использовать предоставляемый Grafana модуль `react-dom/client` для `createRoot`. Не полагаться на приватный штатный sidebar как резервный путь: он не обслуживает произвольные плагины. Ошибка открытия должна быть видна пользователю.

При изменении AMD-зависимостей необходимо обновить factory-моки в тестах и проверить все точки входа, не только плавающую кнопку.

## Источники

- [Grafana 13.2.2 package.json](https://github.com/grafana/grafana/blob/v13.2.2/package.json)
- [Grafana 13.0.2 package.json](https://github.com/grafana/grafana/blob/v13.0.2/package.json)
- [Предоставляемые зависимости в 13.2.2](https://github.com/grafana/grafana/blob/v13.2.2/public/app/features/plugins/loader/sharedDependencies.ts)
- [Ограничение штатного sidebar в 13.2.2](https://github.com/grafana/grafana/blob/v13.2.2/public/app/core/components/AppChrome/ExtensionSidebar/ExtensionSidebarProvider.tsx)

## Живая проверка

Сценарий `test/diagnose-grafana-opening.js` воспроизвёл проблему нажатием оранжевой кнопки на настоящей Grafana 13.2.2 (официальный Docker-образ), в настоящем Edge 155 через переиспользованный Puppeteer. Ничего в коде плагина или ответах Grafana не подменялось.

Фактический результат браузера:

```json
{
  "before": {
    "version": "13.2.2",
    "system": "object",
    "reactDom": { "render": "undefined", "createRoot": "undefined" },
    "client": { "createRoot": "function" }
  },
  "after": { "drawer": false, "assistant": false },
  "errors": []
}
```

То есть кнопка загружена и нажимается, но не создаёт панель; исключений JavaScript нет. Это совпадает с описанием заказчика. Скриншот — `test-results/grafana-1322-opening-before.png` (вне Git).

Тестовый контейнер использовал отдельную временную БД в tmpfs, старый контейнер Grafana 13.0.2 не запускался и его данные не изменялись. После проверки временный контейнер удалён. Образ 13.2.2 сохранён для последующей проверки исправления без повторного скачивания.
