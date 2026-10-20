# SQL и Alerting: план реализации

Основание: `backlog-0.9.4-review.md`, `alerting-backlog-0.9.4.md` и SQL-аудит. Дата: 2026-10-20.

PostgreSQL — основной datasource. Алёртинг — основной продуктовый сценарий. Изображения, OCR и транспорт остаются в текущем виде. Новый backend и серверная авторизация вне этого плана.

| Блок | Состав | Результат | Статус |
|---|---|---|---|
| 1. Достоверный контекст | A1, A2, A4; SQL-таблицы и точность; одинаковые targets проверки и применения | Смена страницы отменяет старый запрос; продолжение сохраняет актуальные факты; SQL не меняет смысл при подготовке контекста | Реализован в 0.9.5 |
| 2. Alert Read | Читающая часть E1; первый срез E2 и E4; A5 | Правило, состояние и экземпляры на страницах Alerting; обзор и разбор без скрытых datasource-запросов | Первый срез в 0.9.5, кейсы добавлены в 0.9.9; полный E1 ещё не заявляется |
| 3. PostgreSQL и аудит правил | SQL Explore/переменные/схема; E3; читающая часть E9 | Реальная схема БД, исправление SQL по ошибке, отчёт качества правил с evidence | Реализован в 0.9.6; ограничения маршрутизации в release notes |
| 4. Черновик и проверка | Builder/валидатор/diff из E1; E5, E6; PostgreSQL-шаблоны | Панель → детерминированный черновик → preview → проверка истории → экспорт/создание paused | Реализован в 0.9.7 в границах простого условия и существующей группы; ограничения в release notes |
| 5. Управление | C4, E8, E10, E14 | План запросов; подтверждённые изменения/silence; provenance; локальный журнал | Реализован в 0.9.8 в границах отдельных правил, простого threshold и точных silence matchers; ограничения гонок API в release notes |
| 6. Расследования и улучшение | B2, B3 + C2; C3 + E11; E12/E13; затем B1/C5 | Сохраняемые кейсы, изменения перед инцидентом, история и runbooks | Приоритетный срез C3/E11 + B3/C2 + B1 реализован в 0.9.9; B2/E12/E13/C5 отложены |

## Правила реализации

- Каждый блок проверяется отдельно; исходные backlog сохраняются как спецификация, а не как утверждение о готовых функциях.
- E1–E4 используют только чтение. Ошибка API или 403 не означает отсутствие алертов. Правило и экземпляр алерта — разные сущности.
- C1 заменён E2; C2 объединён с B3; C3 входит в E11. Никаких дублирующих хранилищ.
- Создание правил, включение, обновление и silence — отдельные действия с preview/подтверждением. Provisioned rules не редактируются. Contact points/policies только читаются.
- SQL backtest требует повторения окна запроса на каждом шаге оценки. Один SQL за весь период с последующим threshold не считается эквивалентом Grafana evaluation. Неподдерживаемые условия отмечаются явно.
- Нет автоматического `EXPLAIN ANALYZE`, записи в Grafana или исполнения предложенного моделью SQL без соответствующего действия пользователя.
- A3: локальные проверки версий/упаковки и CI включаются при подготовке поставки. Смена default branch и публикация релиза — отдельный этап после проверки текущей истории Git.
- B4–B7 и поздние D-пункты не блокируют Alert Read. D1 исключён текущим требованием не менять работу с изображениями.

## Проверки

Unit/isolated: смена dashboard/Explore/Alerting и гонки загрузки; продолжение снимка; SQL table/time_series; неизменность изображений; read-only Alerting, ошибки/403, группировка и отсутствие linked dashboard. Регрессия: существующий набор тестов, обычная упаковка, protected build.

## Протокол 0.9.12

- Закрыты два замечания повторного ревью: строковый datasource UID разрешается через реестр для успешного SELECT и «Примерить»; repair получает исходный интерполированный SQL вместо preview-обёртки. Также исправлены optional chaining и preset существующего silence после очистки startsAt. Подробности: [release notes](release-0.9.12.md).
- 244/244 source и 244/244 protected unit/isolated: PASS. Строковые/унаследованные datasource и объект без type проходят preview/apply; метаданные ограничены `{uid,type}`; DELETE отклоняется без datasource fetch/dashboard GET/POST. Отсутствующий/недоступный реестр не даёт TypeError. Проверены фактическая интерполяция в repair и сохранение формата; LIMIT 101 остаётся только в выполняемом preview.
- 40/40 живых source-проверок и 21/21 целевых protected-проверок: PASS, cleanupErrors=[] (`test-results/release-0.9.12-postgres-source.json`, `test-results/release-0.9.12-postgres-protected.json`). Существующие PostgreSQL/Grafana, SELECT-only fixture. Строковый UID разрешён настоящим реестром, SELECT вернул 101 строку из 1000. Фактическая ошибка PostgreSQL и полный Assistant repair не содержат служебной обёртки; HTTP-body preview содержит LIMIT 101. В полном Assistant protected используются точные production bytes, включая reload после записи; предварительные private-hook probes используют source. Модель/настройки подменены в браузере, успешные SQL/eval/dashboard API настоящие.
- 12/12 живых операций alerting: PASS (`test-results/release-0.9.12-alert-operations.json`). Preset существующего silence сохраняет заполненное начало, восстанавливает очищенное и сбрасывает preview/confirmation без автоматической записи. Создание/продление/завершение проверены настоящим API. UI fixture создаётся с будущим началом, чтобы не смешивать проверку с серверной коррекцией прошедшего startsAt. Проверка успеха требует точного сообщения и не принимает «не подтверждён».
- Обычный ZIP: 7 файлов, SHA-256 `88A927D594B80DE20901C2EFF6D628FBB3F042C4B612D528C925C3EA0E19692D`. Protected: 3 файла, SHA-256 `D964C89530D84FB0F3404D1708389DF4C296B4283E98CE000AD3C3FB5AEAF801`. AMD/contracts/exports/CSP: PASS; cold VM median source 61.2 мс, protected 333.8 мс. Старые ZIP 0.9.11 не менялись; изображения/OCR/MIME/transport не менялись.
- Итоговый независимый read-only аудит: Grafana 13.2.2, зарегистрирован plugin 0.9.12, HTTP module побайтово совпадает с source. Тестовых rules/datasources/folders/dashboards/активных silences/alerts/индекс-аннотаций — 0; временных БД/ролей — 0. Протокол: `test-results/release-0.9.12-final-cleanup.json`.

## Протокол 0.9.11

Уточнение: проверка строкового UID ниже подтверждала отказ unsafe SQL. Успешный SELECT и исходный SQL в repair исправлены и проверены в 0.9.12 выше.

- Исправлены все шесть замечаний: SQL guard на proposal validation/apply и Explore, UUID fallback, raw/invalid local datetime, явный target A/B, курируемые SQL-функции и ограничение repair-draft. Исторические release notes 0.9.10 уточнены: прежний SQL guard не покрывал предложения. Подробности: [release notes](release-0.9.11.md).
- 242/242 source и 242/242 protected unit/isolated: PASS. Для DELETE/UPDATE/writing CTE/chaining/непроверенных функций проверяется ноль datasource fetch, dashboard GET и POST; охвачены наследование datasource, строковый UID, подмена объявленного типа и SQL после интерполяции. Проверено исполнение bounded preview с сохранением format и сохранение полного SQL без preview-обёртки, UUIDv4 fallback, различение пустого/невалидного времени, target refId и cap/маркер длинного repair-draft.
- 38/38 живых source-проверок: PASS (`test-results/hotfix-postgres-source.json`), cleanup=ok. Настоящие PostgreSQL/Grafana: proposal guard до API, 1000 строк → 100+1 в preview, JSON/array/string functions, DST gap без потери ввода/подмены baseline. Полный Assistant получает модельный DELETE: preview и подтверждённое apply отвергаются, unsafeQueries=0 и writes=0 на этом шаге, небезопасной Explore-ссылки нет. Затем выполняются реальная ошибка SELECT, подготовка исправления, выбор B, сброс validation/confirmation при смене периода, конфликт и одна корректная запись; A/format/options сохраняются. Остальная SQL/schema/builder/replay-регрессия пройдена.
- Целевой protected-прогон: 19/19 PASS (`test-results/hotfix-postgres-protected.json`), cleanup=ok. Полный Assistant использует точные production AMD bytes, в том числе при reload после записи, и повторяет DELETE/repair/target-B сценарий. Дополнительный браузер открывает HTTP grafana.test с принудительным resolver в 127.0.0.1: isSecureContext=false, randomUUID отсутствует, builder и case save/import работают через getRandomValues и на source, и на protected. Предварительные изолированные компоненты/SQL-probes в этом прогоне используют source; private hooks в production не добавлялись. Модель/настройки подменены только в браузере; успешные SQL/eval/dashboard API настоящие.
- Обычный ZIP: 7 файлов, SHA-256 `BB1B12BAC5E95145965FAF9592F780EDD6722F31474EC1ED68EAD197981039EA`. Protected: 3 файла, SHA-256 `760783F0E72F5F20750E85906F57266F7B87E7681C227D8EE0FCE229CDF1266C`. AMD/contracts/exports/CSP: PASS; cold VM median source 7.5 мс, protected 186.3 мс. Картинки/OCR/MIME/transport не менялись.

- Регрессия управления/silence: 11 живых проверок PASS; incident/case/notification: 8/8 PASS; apply с двумя targets: PASS, конкурентная правка невыбранного target сохранена, native dialogs=0. Silence UI проверен через существующий preset +1 час. Очистка в тестах завершилась без ошибок.
- Итоговый независимый read-only аудит: Grafana 13.2.2, зарегистрирован plugin 0.9.11; HTTP module побайтово совпадает с source. Тестовых rules/datasources/folders/активных silences/alerts/индекс-аннотаций — 0, временных БД/ролей — 0. Протокол: `test-results/hotfix-final-cleanup.json`.

## Протокол 0.9.10

- Разобраны 10 замечаний: исправлены SQL syntax и аудит expr; добавлены примерка code block, подготовка исправления по фактической ошибке, сворачиваемый diff, ≥/≤, локальное время/presets silence, мультивыбор в поповере и общий watcher. Подтверждение сохранения стало inline; документ Grafana после записи по-прежнему перезагружается. Полный no-panel builder и отложенные B2/E12/E13/C5 не включены. Подробности: [release notes](release-0.9.10.md).
- 234/234 source и 234/234 protected unit/isolated: PASS. Отдельно проверены SQL false positives/запреты, expr/capture groups, равенство порогу, import/lifecycle для ≥/≤, timezone/DST, разворачивание полного diff, сохранение формата target, конкурентные изменения выбранных/невыбранных targets и изменение templateSrv без смены URL.
- 32/32 живых проверок source: PASS, `test-results/review-postgres-source.json`, cleanup=ok. Настоящие PostgreSQL 16.15/Grafana 13.2.2: семь SQL-форм со скобками; SQL/eval/replay gt/gte/lt/lte на равенстве порогу; полный Assistant с фактической ошибкой SQL, ручным отправлением подготовленного исправления, сбросом validation/confirmation при смене периода, блокировкой конкурирующей правки и одной подтверждённой записью. Остальная SQL/schema/builder-регрессия также пройдена. Модель/настройки подменены в браузере; успешные datasource и dashboard API настоящие.
- Protected review: 13/13 PASS, `test-results/review-postgres-protected.json`, cleanup=ok. Точные байты protected module подставлены в браузерный HTTP-ответ до открытия полного Assistant и повторно после сохранения/reload. Полный SQL-сценарий, смена периода, inline confirmation, сохранение и mobile выполнены на production export без private hooks. Предварительные изолированные компоненты и backend-проверки в этом прогоне используют source; production-файлы на сервере не подменялись.
- Регрессия управления/silence: 11 живых проверок PASS; incident/case/notification: 8/8 PASS; навигационный UI 095: PASS. Существующий apply-тест с двумя targets: PASS, конкурентная правка невыбранного target сохранена, native dialogs=0. Время инцидента вводится в часовом поясе браузера и корректно выбирает baseline. Scheduler-тест устанавливает точный silence до включения временного правила; delivery остаётся unknown.
- Обычный ZIP: 7 файлов, SHA-256 `3FBD999E33475A92D86F9F977B5A4806E52A30E0C5B62DCD53BBD14FD2C331A0`. Protected: 3 файла, SHA-256 `BAF223C33BE9529D0B8CE0F9576798A0104024E4504735481F2D2FCC15F34057`. AMD/contracts/exports/CSP: PASS; cold VM median source 8.1 мс, protected 418.5 мс. Метаданные/синтаксис: PASS. Изображения/OCR/MIME/transport не менялись.
- Итоговый независимый read-only контроль: Grafana 13.2.2, зарегистрирован plugin 0.9.10; HTTP module побайтово совпадает с source. Тестовых rules/datasources/folders/активных silences/alerts/индекс-аннотаций — 0, временных БД/ролей — 0. Протокол: `test-results/review-final-cleanup.json`.

## Протокол 0.9.9

- По выбранному порядку реализованы E9 на уровне конкретного экземпляра и наблюдаемого suppression/receiver, C3/E11 (сохранённые версии dashboard), B3/C2 (локальный opt-in кейс + подтверждённая индекс-аннотация), B1 (3 SQL-сценария и до 12 админских prompts). Ограничения — [release notes](release-0.9.9.md).
- 225/225 unit/isolated тестов на исходниках и 225/225 на обфусцированных модулях: PASS. Nested/continue/fallback, actual labels, ограниченный regex, mute/timezone, inhibition/silence status, 403/abort, отсутствие ложного delivery-success, stale evidence, версия до incidentAt и гонки, SQL/variables diff, границы/санитайз/изоляция кейса, сценарии без скрытых запросов.
- 8/8 новых живых проверок: PASS (`test-results/incident-priorities-live.json`). Существующие PostgreSQL 16.15/Grafana 13.2.2; SELECT-only временная роль, реальный SQL/eval и scheduler. Точный silence устанавливался до включения временного firing-правила; подтверждено реальное `silencedBy`, receiver и неизвестная доставка. Rules/policies/contact points организации не перенастраивались. Inhibition/nested/mute/403 проверены unit-тестами, а не живой перестройкой policy.
- Настоящие versions API и сохранённые SQL/переменные v1/v2: выбрана v1 строго до incidentAt. React UI: evidence, opt-in, JSON кейса, восстановление после reload с evidence/diff, preview/confirmation индекс-аннотации, очистка и mobile. Полный Assistant сохраняет абсолютные границы последнего вопроса и текущий SQL, восстанавливает диалог без нового model call; здесь только модель/настройки подменены в браузере, успешные остальные API настоящие.
- SQL/builder-регрессия: 23/23 PASS, `test-results/postgres-live.json`, cleanup=ok. UI 088/090/092/095: PASS на Grafana 13.2.2 с обычными тестовыми подменами model/data/capture. Общие textarea-селекторы уточнены до composer, чтобы не выбирать скрытое поле JSON-импорта.
- Просмотрены `incident-case-mobile.png` и `incident-case-integrated-mobile.png`; основные сценарии остаются четырьмя, notebook и E9 свёрнуты, composer видим на 390×844. Работа изображений/OCR/транспорта не изменялась; attachments.js без diff.
- Обычный ZIP: 7 файлов, структура и байты source — PASS. SHA-256: `9BE6BB419356815332EAD977FFC28946B3C2085594625C2C272F5794701E055F`.
- Protected ZIP: 3 файла, обе серии по 225 тестов, AMD/CSP/экспорты/упаковка — PASS. Cold VM median source 8.4 мс / protected 251.7 мс. SHA-256: `FBBF1B268F2F3B983559F3203F6740DB55F83615AD6F65B17403FDDBC8A3A519`.
- Protected UI: 3/3 PASS (`test-results/protected-priorities-live.json`). В браузерный ответ module.js подставлены точные байты итогового protected module; Grafana/runtime/API настоящие, серверная установка не подменялась. Проверены save → reload → restore кейса без нового model call, mobile composer и E9 при нуле экземпляров. Модель/настройки подменены только в браузере. Скриншот `test-results/protected-case-mobile.png`.
- Финальная независимая очистка: 0 временных БД/ролей, test rules/datasources/folders, активных test silences/instances и test annotations. Бизнес-данные PostgreSQL не читались и не менялись. После restart Grafana health 13.2.2/database=ok, зарегистрированный manifest 0.9.9.

Блок 6 закрыт частично выбранным приоритетным срезом. B2, E12/E13 и универсальные исполняемые C5 отложены; настоящая история доставки/state history не подменяется replay или журналом браузера. Builder полностью без исходной панели пока не добавлен.

## Протокол 0.9.8

- Блок 5 реализован: опциональный plan/approve для native/text query/schema; update/pause/enable/rollback/delete отдельных правил; точные silence matchers с preview/create/extend/expire; provenance; JSON import/export, YAML export/GitOps-патч и локальный журнал. Границы — [release notes](release-0.9.8.md).
- 213/213 unit/isolated тестов на исходниках и 213/213 на обфусцированных модулях: PASS. Включён реальный handler Assistant: до выбора нет datasource-запроса, stop очищает ожидание, после выбора выполняется только отмеченный шаг.
- 11/11 живых проверок блока 5 на существующих PostgreSQL 16.15/Grafana 13.2.2/Edge: PASS. Реальные SQL/eval, PATCH/readback, stale-plan rejection клиентом и сервером (422), rollback, false-condition enable → pause, provenance=api без записи, silence create/extend/expire, React UI diff/confirmation/journal/import/silence и typed delete. Источники и успешные API-ответы не замоканы. Протокол: `test-results/alert-operations-live.json`.
- Grafana 13.2.2 на стенде принимает устаревшие resourceVersion в PUT и DeleteOptions в DELETE. PATCH test проверяется сервером, атомарная CAS хранилища не заявляется. DELETE требует typed UID, повторного чтения и принятия остающегося окна гонки. Provisioned rules, включая api, доступны только для экспорта/GitOps; bypass-заголовков нет.
- SQL-регрессия: 23/23 — PASS, `test-results/postgres-live.json`, cleanup=ok. Селектор мобильной проверки уточнён до composer: общий `textarea` выбирал скрытый JSON import. Карточка Alerting ограничена 55dvh, composer остаётся видимым. Итоговый mobile screenshot просмотрен.
- UI-регрессия 088/090/092/095: PASS на настоящей Grafana; модель/datasource/capture в этих четырёх сценариях замоканы. Компоненты управления/импорта/silence отдельно прогнаны в настоящем React с настоящими API. Скриншоты `test-results/alert-operations-ui.png`, `test-results/alert-operations-mobile.png`. Protected UI отдельно не прогонялся.
- Обычный ZIP: 7 файлов, байтовое совпадение с plugin/ — PASS. SHA-256: `F8B5E10DAD1FDCB3C79946EC6B27F09226761489DB78DCF1D5538EC20721B0E1`.
- Protected ZIP: 3 файла, AMD/CSP/экспорты/упаковка и обе серии 213 тестов — PASS. Cold VM median source 8.4 мс / protected 131.0 мс. SHA-256: `F5C2A3F440DABFE6EDDEA321855A5AA01BADD88186AC59988545AD45AA578819`.
- После тестов независимо подтверждено: 0 временных БД/ролей, 0 тестовых rules/datasources/folders, 0 активных тестовых silence. Expired silence сохраняется штатно в Alertmanager. Бизнес-данные PostgreSQL не использовались. Grafana health 13.2.2/database=ok; зарегистрирован manifest 0.9.8. Изображения/OCR/транспорт не изменены.

На срезе 0.9.8 оставался блок 6; выбранные следующие приоритеты реализованы в 0.9.9 выше. Новые группы, полное E1, произвольный RE2, сложные expressions/import и серверный audit не объявляются завершёнными.

## Протокол 0.9.7

- 200/200 unit/isolated тестов: PASS. Builder/поля/refId, ограничения источников, SQL template identifiers, rolling now на каждом eval, spike/step/pending, unknown/censored gaps, sweep без дополнительных SQL, 403/abort, свежесть и fingerprint проверок, смена состава/interval группы, отсутствие POST без подтверждения, idempotent UID и локальный audit quota.
- 23/23 живых проверок на PostgreSQL 16.15 / Grafana 13.2.2 / Edge: PASS. SQL/error/schema/Explore и аудит из блока 3 сохранены. Fixture: spike попадает ровно в 6 движущихся SQL-окон; 21 отдельный backend eval, pending 2 минуты, firing с t−28m до t−24m; threshold sweep 150 не даёт эпизода. Шаг не укрупнялся.
- Настоящий create API создал paused-правило и вернул его при повторе UID без нового POST. UI прошёл через существующее «Подготовить алерт», сброс proof после правки, preview, явный план/replay, JSON export, подтверждение и журнал. 403 создания симулирован перехватом ответа; успешные eval/SQL/create настоящие. Включение правил не выполнялось.
- Grafana перезапущена для manifest/cache 0.9.7. Изображения/OCR/транспорт не изменены. Временные БД, SELECT-only роль, datasource, dashboard, seed/builder/UI paused-правила и folder удалены в finally.
- UI обычной поставки проверен на desktop и 390×844; `test-results/alert-builder-ui.png`, `test-results/alert-builder-mobile.png` просмотрены. Повторный protected UI остаётся отдельной проверкой.
- UI-регрессия 088/090/092/095 на Grafana 13.2.2: PASS. В этих четырёх сценариях модель/datasource/capture замоканы; реальный SQL и создание проверены отдельно в указанном выше живом прогоне.
- Обычный ZIP: 7 файлов, структура и байтовое совпадение с plugin/ проверены. SHA-256: `727258C6F87374C48C0B6FCFBEC2DCBDD113A3B8DEA9DCB2EE5495BBF293CEDB`.
- Protected ZIP: 3 файла; 200/200 тестов на исходниках и 200/200 на обфусцированных модулях, AMD/CSP/экспорты/упаковка — PASS. Cold VM median: source 9.2 мс, protected 145.4 мс. SHA-256: `78CBD5CBD46B17975EFF75BD2A0912F44FF38E926256FAB34CFE9C36B0FBE46C`. Protected UI отдельно в браузере не прогонялся.
- Финальная очистка подтверждена независимо: 0 временных БД/ролей, 0 тестовых datasource и правил. Grafana health: 13.2.2/database=ok; зарегистрированный plugin manifest: 0.9.7.

На срезе 0.9.7 следующим был блок 5; результат приведён в протоколе 0.9.8. Блок 6, новые группы и полное E1/E9 ещё не завершены.

## Протокол 0.9.6 (предыдущий срез)

- 188/188 unit/isolated тестов: PASS. Включены ограничения SQL-инструмента, метаданные, SQLSTATE feedback, недоступные datasource/allowlist, маршруты nested/continue/fallback, неизвестные/dynamic labels, timezone/calendar/mute timing, 403 и отсутствие contact settings в экспорте.
- 20/20 живых проверок PostgreSQL 16.15 → Grafana 13.2.2 → Edge: PASS. Реальный plugin version 0.9.6 проверен в браузере. Схема/составные FK/индексы доступны SELECT-only роли; SQL-инструмент ограничивает реальные строки, сохраняет time_series и получает настоящий SQLSTATE 42703. Цикл ошибка → columns → исправленный SELECT использует реальные API и заданный тестом сценарий модели.
- SQL → Explore сохраняет datasource/range и подставленные multivalue-переменные; All/апостроф/NULL/пустые результаты и SQL Error проверены на сервере.
- Аудит получает реальные rules/policies/contact points/mute timings. Свёрнутый UI, фильтр, JSON/Markdown export и доступность composer на 390×844 проверены в браузере; скриншоты `test-results/postgres-audit-ui.png`, `test-results/postgres-audit-mobile.png` просмотрены.
- UI-регрессия `verify-088`, `verify-092`, `verify-095`: PASS на настоящей Grafana 13.2.2; в этих трёх сценариях модель/datasource-ответы замоканы. Изображения/OCR/транспорт не менялись.
- Временные БД/роль/datasource/дашборд/paused-правило удалены. Правила не включались; доставка уведомлений и исторический replay не проверялись.
- Обычный ZIP 0.9.6: 7 файлов, структура и байтовое совпадение с plugin/ проверены. SHA-256: `0BF40B670792AED5089122D7CED89DA279D865CB94957511D9239AE9328538E2`.
- Protected ZIP 0.9.6: 3 файла; 188/188 тестов на исходниках и 188/188 на обфусцированных модулях, AMD/CSP/экспорты/упаковка — PASS. Cold VM median: source 6.3 мс, protected 118.7 мс. SHA-256: `D3EF124D83D4C09345885FF36915A6872887AB78CCC076A06AE30241523D9676`. Отдельный браузерный прогон protected UI не выполнялся.

На этом срезе следующим был блок 4; его результат приведён в протоколе 0.9.7 выше.

## Протокол 0.9.5 (предыдущий срез)

- 175 unit/isolated тестов на исходниках: PASS, включая настоящие эффекты Assistant при переходах между дашбордами, панелью, Explore и Alerting.
- Grafana 13.2.2 / React 19 / установленный Edge: `verify-088`, `verify-090`, `verify-092`, `verify-095` — PASS. Настоящие UI и API Grafana; модель и datasource-ответы в UI-регрессии замоканы.
- `verify-095`: реальные временные дашборды и paused-правило созданы через API и удалены в finally; SPA-переход A→B→Alerting, изоляция диалогов, разбор без datasource-запросов, 403. Проверка горящего production-алерта не выполнялась.
- Обычный ZIP: проверены структура и байтовое совпадение всех 7 файлов с plugin/.
- Protected build: 175/175 тестов на исходниках и 175/175 на обфусцированных модулях; проверки AMD/CSP/экспортов и упаковки прошли. Медиана холодной VM-инициализации: source 5.9 мс, protected 86.2 мс. Проверка выполнялась без параллельного браузерного прогона после ложного превышения бюджета под нагрузкой.
- Изображения/OCR/транспорт: исходники attachments.js не менялись; существующие unit и браузерные проверки прошли.
- PostgreSQL 16.15: живой прогон `node test/verify-postgres-live.cjs` через Grafana 13.2.2 и Edge на существующем `voice2price-pilot-postgres-1`. Проверены реальные table/time_series, timeFilter/timeGroupAlias/interval, multivalue/All с SQL-экранированием апострофа, NULL, пустой результат, ошибка SQL, отказ записи SELECT-only роли и проверка частичного target. Ответы datasource не подменяются.
- SQL Alerting: чтение реального paused-правила без linked dashboard и повторная выборка его SQL; `/api/v1/eval` выполняет SQL → reduce → threshold, подтверждены результаты 1/0 и отдельные NoData/SQL Error. Это разовая проверка condition, не исторический replay и не проверка доставки уведомлений. Схема/SQL tools и replay остаются блоками 3–4.
- Живой SQL-прогон создаёт отдельные временные БД/роль/datasource/дашборд/paused-правило и удаляет их в finally. Данные приложения в PostgreSQL не читались и не менялись. Протокол: `test-results/postgres-live.json`.
- CI добавлен локально; remote workflow, публикация, тег и изменение default branch не выполнялись.

Активный стенд: [Grafana 13.2.2](http://localhost:3300/crf/dashboard/). Запуск/восстановление: `powershell -File scripts/start-grafana.ps1`. Образ 13.0.2 удалён. Данные существующего контейнера и volume сохранены.

Артефакты:

- `output/tech-ai-assistant-app-0.9.5.zip`, SHA-256 `6D3169F94111EE79AAA0E3E71D642EF9F68A464BA1C1C8EF99F8D73463DDB37A`.
- `output/tech-ai-assistant-app-0.9.5-protected.zip`, SHA-256 `5CCDFB5B17DC136932CB0AE3C5C49DF8E286F9A00F4C5F4D79348CABD0835200`.
- Живой UI прогнан на исходной поставке. Protected-поставка проверена в VM и unit-тестах; отдельный прогон protected UI на этом срезе не выполнялся.
