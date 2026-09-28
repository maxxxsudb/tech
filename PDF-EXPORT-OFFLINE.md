# Установка grafana-export-to-pdf без интернета

[arthur-mdn/grafana-export-to-pdf](https://github.com/arthur-mdn/grafana-export-to-pdf) — не плагин Grafana,
а отдельный сервис (Node.js + Chromium) в Docker-контейнере. Он открывает дашборд в headless-браузере
и сохраняет его в PDF. В Grafana добавляется пункт **Export → Export as PDF**.

Пошаговая инструкция проверена на Grafana 12.2.0 в Docker-сети **без выхода в интернет**:
PDF генерируется через API и через кнопку в интерфейсе, кириллица отображается.

> Экспортёр рассчитан на **Grafana 12**. Кнопка встраивается в интерфейс Grafana 12 и в других версиях может не появиться.

Что переносится на сервер:

| Файл | Откуда |
|---|---|
| `grafana-export-to-pdf_0ce30e2.tar.gz` (~370 МБ) | собирается в шагах 1–2 |
| `grafana-button.html` | [grafana/grafana-button.html](grafana/grafana-button.html) в этом репозитории |

## Шаг 1. Собрать образ (на машине с интернетом)

```bash
git clone https://github.com/maxxxsudb/tech.git
cd tech/grafana-export-to-pdf
docker build -t grafana-export-to-pdf:0ce30e2 .
```

[Dockerfile](grafana-export-to-pdf/Dockerfile) берёт исходники экспортёра с зафиксированного
коммита `0ce30e2` и ставит Chromium. В готовом образе есть всё, интернет ему больше не нужен.

## Шаг 2. Выгрузить образ в файл

```bash
docker save grafana-export-to-pdf:0ce30e2 | gzip > grafana-export-to-pdf_0ce30e2.tar.gz
sha256sum grafana-export-to-pdf_0ce30e2.tar.gz
docker images grafana-export-to-pdf
```

Запишите SHA256 и `IMAGE ID`, они понадобятся на шаге 4. Эти значения свои для каждой
сборки, поэтому сравнивайте их со своими цифрами, а не с чужими.

## Шаг 3. Перенести файлы на сервер

Перенесите `grafana-export-to-pdf_0ce30e2.tar.gz` и `grafana-button.html`, затем проверьте архив:

```bash
sha256sum grafana-export-to-pdf_0ce30e2.tar.gz
```

Сумма должна совпасть с шагом 2. Если не совпала, архив повреждён при переносе.

## Шаг 4. Загрузить образ в Docker

```bash
docker load -i grafana-export-to-pdf_0ce30e2.tar.gz
docker images grafana-export-to-pdf
```

Ожидается `Loaded image: grafana-export-to-pdf:0ce30e2`, и `IMAGE ID` совпадает с шагом 2.

## Шаг 5. Запустить Grafana с разрешённым HTML в панелях

Кнопка экспорта — это HTML/JS внутри text-панели, поэтому Grafana должна разрешать такой HTML.
Экспортёр будет работать в сетевом пространстве контейнера Grafana (шаг 6), поэтому
**порт 3001 публикуется на контейнере Grafana**:

```bash
docker run -d --name grafana \
  -p 3000:3000 -p 3001:3001 \
  -e GF_PANELS_DISABLE_SANITIZE_HTML=true \
  -e GF_PLUGINS_PREINSTALL_DISABLED=true \
  grafana/grafana:12.2.0
```

Если Grafana уже запущена без `-p 3001:3001`, контейнер придётся пересоздать с этим параметром.
Используйте свои тома и настройки, чтобы не потерять данные.

Для Grafana без Docker в `grafana.ini`:

```ini
[panels]
disable_sanitize_html = true
```

## Шаг 6. Запустить экспортёр

```bash
docker run -d --name grafana-export-to-pdf \
  --network container:grafana \
  -e GRAFANA_USER=admin -e GRAFANA_PASSWORD=admin \
  -e FORCE_KIOSK_MODE=true -e HIDE_DASHBOARD_CONTROLS=true -e EXPAND_COLLAPSED_PANELS=true \
  -e PDF_WIDTH_PX=1920 -e PDF_HEIGHT_PX=auto \
  -e NAVIGATION_TIMEOUT=120000 -e PANEL_RENDER_TIMEOUT=8000 \
  -v /opt/grafana-pdf-output:/usr/src/app/output \
  grafana-export-to-pdf:0ce30e2
```

- `--network container:grafana` — у экспортёра общая сеть с Grafana, и внутри него `localhost:3000` —
  это Grafana.
- `GRAFANA_USER` / `GRAFANA_PASSWORD` — логин, под которым экспортёр открывает дашборды.
  Хватит пользователя с ролью **Viewer**. Вместо пароля можно указать токен сервисного аккаунта:
  `-e GRAFANA_SERVICE_ACCOUNT=true -e GRAFANA_PASSWORD=<токен>`.
- Готовые PDF сохраняются в `/opt/grafana-pdf-output`.

**Grafana установлена без Docker:** вместо `--network container:grafana` используйте `--network host`
и не указывайте `-p`, экспортёр будет слушать порт 3001 на самом сервере. Этот вариант в нашем
тесте не проверялся, в upstream он используется по умолчанию.

## Шаг 7. Проверить экспортёр

```bash
curl http://localhost:3001/check-status
```

Ожидается: `Server is running`.

Экспорт любого дашборда (UID есть в адресе дашборда: `/d/<uid>/...`):

```bash
curl -H "Content-Type: application/json" -X POST \
  -d '{"url":"http://localhost:3000/d/<uid>"}' \
  http://localhost:3001/generate-pdf
```

Ожидается ответ `{"pdfUrl":"http://localhost:3001/output/<имя>.pdf"}`, и файл появится в `/opt/grafana-pdf-output`:

```bash
head -c 5 /opt/grafana-pdf-output/*.pdf    # должно вывести %PDF-
```

## Шаг 8. Добавить кнопку в Grafana

1. Откройте `grafana-button.html` и найдите строку:

   ```javascript
   window.gfexpPdfGenerationServerUrl = 'http://localhost:3001';
   ```

   Этот адрес вызывает **браузер пользователя**, а не сервер. Если Grafana открывают с других
   компьютеров, укажите адрес сервера, например `'http://grafana.example.local:3001'`.
   Вариант `localhost` подходит, только если браузер работает на том же сервере.

2. Откройте дашборд → **Edit** → **Add** → **Visualization** → тип панели **Text**.
3. Справа в **Mode** выберите **HTML** и вставьте в **Content** всё содержимое `grafana-button.html`.
4. Сохраните дашборд. В панели должна появиться строка с названием дашборда и периодом.

Кнопку нужно добавить на каждый дашборд, который хотите выгружать.

## Шаг 9. Проверить кнопку

1. На дашборде нажмите **Export** (справа вверху) → **Export as PDF**.
2. Откроется панель **Export dashboard as PDF**. Выберите тему (Current / Dark / Light) и нажмите **Generate PDF**.
3. Откроется новая вкладка с PDF.

Если вкладка не открылась, браузер заблокировал всплывающее окно. Разрешите всплывающие окна
для адреса Grafana (значок в адресной строке) и повторите.

## Если не работает

| Что видно | Причина |
|---|---|
| Нет пункта **Export as PDF** | На дашборде нет text-панели с кнопкой, или не включён `disable_sanitize_html` (шаг 5), или это не Grafana 12 |
| Кнопка **Generate PDF** неактивна или показывает ошибку подключения | Браузер не достаёт до адреса из `gfexpPdfGenerationServerUrl` (шаг 8): неверный адрес или закрыт порт 3001 |
| `Unable to access URL. HTTP status: 401` | Неверные `GRAFANA_USER` / `GRAFANA_PASSWORD` |
| Ошибка доступа к URL / таймаут | Экспортёр не достаёт до адреса Grafana, который видит браузер. Проверьте изнутри: `docker exec grafana-export-to-pdf curl -sI <адрес Grafana>` |
| В PDF страница логина вместо дашборда | Для пользователя экспортёра в Grafana отключена basic-авторизация. Используйте токен сервисного аккаунта |

Логи экспортёра: `docker logs grafana-export-to-pdf`.
