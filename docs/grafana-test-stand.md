# Тестовый стенд Grafana 13.2.2

Адрес: http://localhost:3300/crf/dashboard/  
Контейнер: `tech-ai-grafana-test`, образ `grafana/grafana:13.2.2`, restart policy `unless-stopped`.  
Данные: существующий volume `tech-git-sync-grafana-data`. Plugin bind mount: `ai-assistant/plugin`, read-only.

## Запуск и проверки

```powershell
powershell -File scripts/start-grafana.ps1
powershell -File scripts/test-grafana.ps1
```

`start-grafana.ps1` проверяет Docker Desktop, запускает существующий контейнер и проверяет health/version/database. Если у работающего контейнера пропала фактическая публикация порта, восстанавливает её перезапуском. Контейнеры не пересоздаются, volumes не удаляются. `-Restart` явно перезапускает Grafana.

Браузер — локальный Edge через Puppeteer Core. Node/Chromium в контейнер Grafana не устанавливаются. Скриншоты находятся в `test-results/grafana-13.2.2/`. Можно передать один case или список через запятую в `-Cases`.

## Восстановление 2026-10-20

1. Backend-процессы Docker оставались запущенными, но Desktop сообщал `stopped`, WSL `docker-desktop` тоже был остановлен. Обычный `desktop start` ошибочно считал Desktop уже работающим. `docker desktop restart --detach` восстановил Linux engine.
2. Существующий контейнер уже использовал 13.2.2. После запуска engine пропала runtime-публикация `3000/tcp`, хотя `HostConfig.PortBindings` содержал `127.0.0.1:3300`. Перезапуск только Grafana восстановил порт.
3. Неиспользуемый образ `grafana/grafana:13.0.2` удалён без force; контейнеров на этой версии не было. Существующие данные и конфигурация Grafana не удалялись.
4. Health подтвердил `version=13.2.2`, `database=ok`; Alerting GET endpoints отвечают 200. Браузерные сценарии 088/090/092/095 прошли.

Docker Desktop должен работать, чтобы Grafana была доступна. Скрипт восстанавливает его при запуске проверок; остановка Desktop пользователем остановит и контейнеры.

## Живой PostgreSQL

Используется существующий `voice2price-pilot-postgres-1` (PostgreSQL 16.15), подключённый к сети `tech-ai-test`. Контейнер запущен; приложение voice2price и backup-контейнер не запускались. Порт PostgreSQL на хост не публикуется.

```powershell
powershell -File scripts/start-grafana.ps1
node test/verify-postgres-live.cjs
```

Проверка создаёт отдельные временные БД, SELECT-only роль с одноразовым паролем, datasource, дашборд и paused-правило. Проверяет реальные SQL-ответы через браузерный Grafana datasource и функции плагина, включая multivalue/All и SQL-макросы. Alert condition вычисляется самой Grafana через `/api/v1/eval`: SQL → reduce → threshold, варианты 1/0, NoData и SQL Error. Правило не включается, уведомления не отправляются.

Временные объекты удаляются в finally; ошибки очистки делают прогон неуспешным. Существующие бизнес-таблицы не используются. При необходимости скрипт подключает контейнер к тестовой сети на время прогона; уже существующее подключение сохраняет. Настройки: `POSTGRES_TEST_CONTAINER`, `GRAFANA_TEST_URL`, `GRAFANA_TEST_USER`, `GRAFANA_TEST_PASSWORD`, `BROWSER_EXECUTABLE`. JSON-протокол без паролей: `test-results/postgres-live.json`.

Для 0.9.6 прогон расширен до 20 проверок: реальная схема, составные FK и индексы, ограниченные SQL tools и цикл исправления по 42703, SQL Explore с переменными, читающий аудит правил, экспорт и узкий viewport. Сценарий ответов модели задан тестом; datasource и Alerting API настоящие. Снимки UI: `test-results/postgres-audit-ui.png` и `test-results/postgres-audit-mobile.png`.

В 0.9.7 — 23 проверки. Добавлены детерминированный builder, 21 точный шаг rolling SQL replay на spike-fixture и создание paused с проверкой повторного UID; отдельный UI-проход preview → replay → export → подтверждение → paused → локальный audit. Успешные API настоящие; UI 403 симулирован. Все созданные правила удаляются в finally, включая заранее зарегистрированные UID при ошибке/неопределённом ответе. SQL-прогон теперь проверяет plugin version 0.9.7; после обновления manifest стенд перезапущен. UI-снимки: `test-results/alert-builder-ui.png`, `test-results/alert-builder-mobile.png`.
