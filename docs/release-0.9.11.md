# 0.9.11 — SQL guard для предложений, HTTP и локальное время

## Исправление SQL-предложений

В 0.9.10 и более раннем пути dashboard-json проверка/сохранение предложения не вызывали SQL guard. Подтверждён дефект: SQL вида DELETE мог попасть в datasource query или сохранённый target. Новый путь code block сделал этот пропуск доступнее. В 0.9.11 guard применяется к обоим путям; старые ZIP не переписывались.

- Исходный SQL проверяется до datasource HTTP и чтения/записи dashboard. Затем проверяется результат подстановки переменных; перед записью проверяется выбранный target из свежей серверной версии. Datasource type берётся из текущего контекста/реестра, а наличие rawSql дополнительно требует SQL-проверки независимо от объявленного в предложении типа.
- Preview использует возвращённый bounded SQL: 100 строк + одна для обнаружения переполнения, rawQuery/code mode. Исходный format сохраняется. Лимит строк не ограничивает стоимость scan. В dashboard сохраняется полный исходный запрос, без preview-обёртки.
- Для небезопасного/неподдержанного SQL и ещё не подставленных dashboard-переменных ссылки Explore скрываются, чтобы открытие ссылки не стало обходом проверки. Неизвестные функции и writing CTE/несколько команд/DDL/DML/locking по-прежнему отклоняются. Это клиентская проверка поддержанного SQL, не замена правам PostgreSQL и не новый серверный механизм авторизации.
- В allowlist добавлены курируемые JSON/array/string/date-функции, включая to_jsonb, jsonb_path_query, array_length, string_to_array, regexp_split_to_table и format. I/O/state-функции pg_*, dblink, lo_*, nextval/setval/set_config и функции чужой схемы не разрешены. Основание: [PostgreSQL 16 JSON](https://www.postgresql.org/docs/16/functions-json.html), [arrays](https://www.postgresql.org/docs/16/functions-array.html), [strings](https://www.postgresql.org/docs/16/functions-string.html).

## Остальные замечания

- UUID создаётся через randomUUID либо UUIDv4 на getRandomValues. Builder, импорт правила и сохранение/импорт кейса используют один helper. Fallback работает на HTTP-origin, где randomUUID отсутствует. [MDN randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID), [getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues).
- В incident/silence хранится введённое локальное время отдельно от ISO. Невалидная/неполная дата и DST gap показываются inline и блокируют действие, сохраняя ввод. Ошибка не превращается в запрос «сравнить с предыдущей версией». Явное очищение optional incident time сохраняет прежний режим предыдущей версии. Preset silence исправляет ввод и сбрасывает preview/confirmation. Неоднозначный осенний час по-прежнему разрешается стандартным правилом браузера.
- При нескольких совместимых targets «Примерить» открывает явный выбор запроса A/B. До выбора нет предложения, проверки или записи. Остальные targets и настройки выбранного запроса сохраняются. Для нескольких targets нужны уникальные устойчивые refId; неизвестный индекс не угадывается.
- Черновик «Исправить ошибку» ограничен максимумом 8000 символов с учётом contextTokens. Фактическая ошибка идёт перед SQL; сокращение явно обозначено. Полный запрос в исходном сообщении не меняется. Ограничение уменьшает риск переполнения, но не обещает вместить произвольный контекст в любое окно модели.

Изображения, OCR, MIME и транспорт не изменены. Новых backend/dependencies нет. Полный no-panel alert-builder и B2/E12/E13/C5 не включены.

## Проверки

Результаты, границы проверки и хеши поставок: [implementation-blocks.md](implementation-blocks.md). Для опасных SQL проверяется отсутствие HTTP/POST, а не успешное удаление данных. Живые тесты используют изолированные временные ресурсы и SELECT-only роль существующего PostgreSQL. HTTP fallback проверяется на grafana.test, принудительно направленном браузером в 127.0.0.1; это настоящий insecure context. Модель/настройки в UI подменены, PostgreSQL/eval/dashboard API настоящие. Временные ресурсы очищаются в finally.
