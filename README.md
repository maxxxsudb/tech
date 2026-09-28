# tech

Тестовый стенд в Docker:

- **Keycloak 26.7.4 → OTLP-логи** → OpenTelemetry Collector → Loki → Grafana
- **Grafana Infinity datasource** (`yesoreyeram-infinity-datasource`) на mock-API (JSON/CSV)
- **grafana-export-to-pdf** ([arthur-mdn/grafana-export-to-pdf](https://github.com/arthur-mdn/grafana-export-to-pdf)) — экспорт дашбордов Grafana в PDF

## Запуск

```bash
docker compose up -d --build
./scripts/test.sh
```

| Сервис | URL | Логин |
|---|---|---|
| Keycloak | http://localhost:8080 | admin / admin |
| Grafana | http://localhost:3000 (дашборд `Tech / Tech stand`) | admin / admin |
| grafana-export-to-pdf | http://localhost:3001/check-status | — |
| Loki | http://localhost:3100 | — |
| OTLP (collector) | grpc `:4317`, http `:4318` | — |

## Что проверяет `scripts/test.sh`

1. **Keycloak → OTLP.** Делает неудачный и удачный логин в `admin-cli`, затем проверяет,
   что в stdout коллектора есть записи `service.name=keycloak` и событие `LOGIN_ERROR`,
   а в Loki находятся `{service_name="keycloak"}` и событие `LOGIN`.
2. **Infinity.** Плагин установлен, health check datasource OK, запросы через `/api/ds/query`
   к `http://mock-api/users.json` (4 строки) и `sales.csv` (6 строк), запрос к хосту
   вне `allowedHosts` отклоняется.
3. **Export to PDF.** `POST /generate-pdf` для дашборда `tech`, скачанный файл — валидный PDF
   (`output/test.pdf`).

## Как устроено

**Keycloak.** Экспорт логов по OTLP — preview-фича, появилась в 26.x (в 26.4 её ещё нет):

```
--features=opentelemetry-logs
--telemetry-logs-enabled=true
--telemetry-endpoint=http://otel-collector:4317
--telemetry-protocol=grpc
```

`--spi-events-listener--jboss-logging--success-level=info` выводит успешные события
(`LOGIN` и т.п.) на уровне INFO, иначе они пишутся в DEBUG и не экспортируются.

**Collector** (`otel-collector/config.yaml`) пишет всё в `debug`-экспортер
(`docker compose logs otel-collector`) и в Loki через нативный OTLP (`/otlp`).

**Grafana.** Плагин Infinity ставится через `GF_PLUGINS_PREINSTALL_SYNC`, datasources
и дашборд — provisioning. `GF_PANELS_DISABLE_SANITIZE_HTML=true` нужен для кнопки экспорта.

**grafana-export-to-pdf** собирается из исходников (`grafana-export-to-pdf/Dockerfile`,
пиннинг коммита через `GFEXP_REF`) и работает в сетевом неймспейсе Grafana
(`network_mode: service:grafana`), поэтому URL из браузера `http://localhost:3000/d/...`
внутри экспортёра тоже указывает на Grafana. В Grafana ходит по Basic-auth (admin/admin).
Готовые PDF — в `./output`.

Кнопка экспорта: text-панель «Export to PDF» на дашборде содержит `grafana/grafana-button.html`
из upstream; кнопка появляется в штатном меню Export дашборда. Дашборд пересобирается так:

```bash
python scripts/build-dashboard.py
```

Экспорт вручную:

```bash
curl -H "Content-Type: application/json" -X POST \
  -d '{"url":"http://localhost:3000/d/tech/tech-stand","from":"now-1h","to":"now"}' \
  http://localhost:3001/generate-pdf
```

## Среда без интернета

Grafana не обязана качать Infinity при старте: плагин можно положить файлами.

1. На машине с интернетом: `./scripts/offline-bundle.sh`. Скрипт скачает плагин
   (`OS_ARCH=linux-arm64` для ARM), выгрузит все Docker-образы в `offline/images.tar`
   и соберёт `../offline-bundle.tar.gz`.
2. Перенести архив, на целевой машине:

   ```bash
   tar xzf offline-bundle.tar.gz && cd tech
   docker load -i offline/images.tar
   docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
   ```

`docker-compose.offline.yml` монтирует `offline/plugins` в `/var/lib/grafana/plugins`,
отключает установку плагинов при старте (`GF_PLUGINS_PREINSTALL_DISABLED`) и проверки
обновлений. Проверено: Grafana в сети без выхода наружу регистрирует Infinity и отдаёт данные.

Для Grafana без Docker: распаковать zip плагина в каталог плагинов
(по умолчанию `/var/lib/grafana/plugins`) и перезапустить Grafana. Плагин подписан Grafana,
подпись проверяется локально, интернет не нужен.

## Остановка

```bash
docker compose down -v
```
