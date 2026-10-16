# Установка ZIP в distroless Grafana без интернета

Для 0.9.4+ архив содержит папку `tech-ai-assistant-app/`. Плоский ZIP 0.9.3 не использовать со штатной предустановкой: на Grafana 13.2.2 воспроизведено падение запуска с `failed to extract plugin archive: archive member "attachments.js" tries to write outside of plugin directory`.

## Внутренний HTTPS-сервер с собственным CA

Нужны ZIP во внутреннем хранилище, доступном из пода, и PEM-файл доверенного CA этого сервера. Для действительно самоподписанного сертификата это сам сертификат сервера; для корпоративного CA используйте его корневой CA и необходимые промежуточные сертификаты. Приватный ключ не нужен и не должен попадать в ConfigMap.

Создать ConfigMap в namespace Grafana (замените `NAMESPACE`):

```sh
kubectl -n NAMESPACE create configmap grafana-internal-ca --from-file=internal-ca.crt=./internal-ca.crt
```

Ниже фрагмент **существующего** Deployment/StatefulSet. Объедините списки с текущими, не заменяйте весь объект; имя контейнера сохраните своё. В URL замените `YOUR_INTERNAL_HOST` на реальное имя внутреннего хранилища. У сертификата это имя должно входить в SAN.

```yaml
spec:
  template:
    spec:
      containers:
        - name: grafana
          env:
            - name: GF_PLUGINS_PREINSTALL_SYNC
              value: "tech-ai-assistant-app@0.9.4@https://YOUR_INTERNAL_HOST/tech-ai-assistant-app-0.9.4.zip"
            - name: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS
              value: "tech-ai-assistant-app"
            - name: SSL_CERT_DIR
              value: "/etc/grafana/custom-ca"
          volumeMounts:
            - name: grafana-internal-ca
              mountPath: /etc/grafana/custom-ca
              readOnly: true
      volumes:
        - name: grafana-internal-ca
          configMap:
            name: grafana-internal-ca
```

Это Kubernetes-монтирование, поэтому в образе не нужны `sh`, `tar`, пакетный менеджер или `update-ca-certificates`. Образ менять не требуется. `SSL_CERT_DIR` указывает директорию с PEM-сертификатами; не монтируйте её поверх системного каталога CA. Если переменная уже настроена, дополните существующий каталог/список путей, а не удаляйте старые сертификаты. Существующие значения списков preinstall/unsigned также нужно дополнить, а не стереть.

Примените изменение в Helm/GitOps-источнике, если именно он управляет Deployment, и выполните rolling restart. Затем в браузере — `Ctrl+F5`.

Важно: `GF_PLUGINS_PREINSTALL_DISABLED=true` отключает и явный `GF_PLUGINS_PREINSTALL_SYNC`. Для этого способа предустановка должна быть разрешена. Если папка плагинов read-only, сначала потребуется доступный для записи volume для установщика. Не используйте одновременно старый ConfigMap-плагин и предустановку в тот же каталог.

Для полностью локального файла на PVC это не HTTP URL: приведённая настройка предназначена для внутреннего HTTPS-хранилища. Без такого сервера можно смонтировать распакованные файлы плагина отдельным ConfigMap — размер 0.9.4 около 339 КБ, меньше лимита ConfigMap 1 МиБ.

## Проверки

Grafana 13.2.2 в Docker network `internal=true`, без выхода в интернет:

- Плоский ZIP 0.9.3: фатальная ошибка извлечения при синхронной предустановке.
- ZIP 0.9.4 с папкой plugin ID: штатная HTTP-предустановка успешна, `grafana cli plugins ls` видит 0.9.4.
- HTTPS с самоподписанным сертификатом без CA: штатный CLI воспроизводит `x509: certificate signed by unknown authority`.
- Тот же HTTPS с read-only CA и `SSL_CERT_DIR`: штатный CLI скачивает и распаковывает 0.9.4 без `--insecure`.
- Полный запуск сервера с `GF_PLUGINS_PREINSTALL_SYNC` по тому же HTTPS и собственным CA: плагин зарегистрирован, `/api/health` возвращает `database=ok`, установленный `module.js` отдаётся по HTTP. SHA-256 всех шести реально установленных файлов совпадает с `plugin/`.

Проверен официальный образ `grafana/grafana:13.2.2`, не distroless-вариант; бинарный установщик работает без вызова shell. Kubernetes-монтирование в кластере заказчика здесь не выполнялось.

Источники: [упаковка Grafana-плагина](https://grafana.com/developers/plugin-tools/publish-a-plugin/package-a-plugin), [ConfigMap](https://kubernetes.io/docs/concepts/configuration/configmap/), [системные CA в Go](https://pkg.go.dev/crypto/x509#SystemCertPool).
