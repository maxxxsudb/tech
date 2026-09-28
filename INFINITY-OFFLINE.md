# Установка плагина Grafana Infinity без интернета

Пошаговая инструкция. Проверена на Grafana 12.2.0 (Docker) и Infinity 3.11.1:
плагин регистрируется, health check успешен, запросы возвращают данные.

Эталонные контрольные суммы для Infinity **3.11.1, linux-amd64**:

| Файл | Сумма |
|---|---|
| `infinity.zip` | MD5 `f6d6b2cc9ef763f554d546d8f3ac35cb` |
| `gpx_infinity_linux_amd64` | SHA256 `5e58806487eae1881369fe013e9655085aba581a789f5ded1bb4c78f8374c581` |

## Шаг 1. Скачать архив (на машине с интернетом)

```bash
curl -fL -o infinity.zip "https://grafana.com/api/plugins/yesoreyeram-infinity-datasource/versions/3.11.1/download?os=linux&arch=amd64"
md5sum infinity.zip
```

Ожидается: `f6d6b2cc9ef763f554d546d8f3ac35cb`.

> Ссылку обязательно брать **в кавычки**, иначе bash обрежет её на `&` и скачается другой файл.
>
> Флаг `-L` обязателен: grafana.com отдаёт файл через перенаправление, и без `-L` curl сохранит
> вместо архива крошечный ответ сервера (~200 байт). `-f` не даёт сохранить страницу с ошибкой под видом архива.

## Шаг 2. Перенести `infinity.zip` на сервер и проверить ещё раз

```bash
md5sum infinity.zip
```

Ожидается: `f6d6b2cc9ef763f554d546d8f3ac35cb`. Если сумма другая — файл повреждён при переносе,
дальше не идти, скачать заново.

## Шаг 3. Распаковать в каталог плагинов

```bash
mkdir -p /opt/grafana-plugins
unzip -q infinity.zip -d /opt/grafana-plugins
sha256sum /opt/grafana-plugins/yesoreyeram-infinity-datasource/gpx_infinity_linux_amd64
```

Ожидается: `5e58806487eae1881369fe013e9655085aba581a789f5ded1bb4c78f8374c581`.

## Шаг 4. Запустить бинарник плагина вручную

```bash
/opt/grafana-plugins/yesoreyeram-infinity-datasource/gpx_infinity_linux_amd64; echo "exit=$?"
```

Ожидается:

```
This binary is a plugin. These are not meant to be executed directly.
Please execute the program that consumes these plugins, which will
load any plugins automatically
exit=0
```

## Шаг 5. Запустить Grafana с этим каталогом

```bash
docker run -d --name grafana -p 3000:3000 \
  -v /opt/grafana-plugins:/var/lib/grafana/plugins \
  -e GF_PLUGINS_PREINSTALL_DISABLED=true \
  grafana/grafana:12.2.0
```

`GF_PLUGINS_PREINSTALL_DISABLED=true` — чтобы Grafana при старте не пыталась ничего скачивать.

Для Grafana без Docker — в `grafana.ini`:

```ini
[plugins]
preinstall_disabled = true
[analytics]
check_for_updates = false
check_for_plugin_updates = false
```

и распаковать плагин в каталог плагинов этой Grafana (по умолчанию `/var/lib/grafana/plugins`).

## Шаг 6. Проверить

```bash
docker logs grafana 2>&1 | grep -i infinity
```

Ожидается: `msg="Plugin registered" pluginId=yesoreyeram-infinity-datasource`.

В браузере: **Connections → Data sources → Add data source → Infinity → Save & test** —
должна появиться зелёная плашка **Health check successful**.

## Если не работает

- **MD5 (шаг 2) или SHA256 (шаг 3) не совпали** — файл повреждён при скачивании или переносе.
- **Суммы совпали, но на шаге 4 `Segmentation fault`** — бинарник идентичен проверенному,
  причина в окружении сервера (ядро, защита ОС). Собрать для разбора:

  ```bash
  uname -r
  cat /etc/os-release | head -3
  /opt/grafana-plugins/yesoreyeram-infinity-datasource/gpx_infinity_linux_amd64 2>&1 | head -20
  dmesg | tail -20
  ```

- Можно попробовать более старые версии, собранные предыдущими версиями Go
  (в ссылке шага 1 заменить `3.11.1`):

  | Плагин | Собран Go | Нужна Grafana |
  |---|---|---|
  | 4.0.0, 3.11.1, 3.8.0, 3.7.4 | 1.26 | 11.6+ |
  | 3.7.0 | 1.25.4 | 10.4.8+ |
  | 3.6.0 | 1.25.1 | 10.4.8+ |
  | 3.4.1 | 1.24.4 | 10.4.8+ |
