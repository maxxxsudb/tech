#!/usr/bin/env bash
# Проверки стенда: Keycloak -> OTLP -> Loki, Grafana Infinity, grafana-export-to-pdf.
# Запуск: docker compose up -d --build && ./scripts/test.sh
set -u
cd "$(dirname "$0")/.."

KC=http://localhost:8080
GF=http://localhost:3000
PDF=http://localhost:3001
fail=0
ok()  { echo "  [OK]   $*"; }
bad() { echo "  [FAIL] $*"; fail=1; }

wait_for() { # url, name
  for _ in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 2; done
  bad "$2 не поднялся ($1)"; return 1
}

echo "== Ожидание сервисов"
wait_for "$KC/realms/master" keycloak
wait_for "$GF/api/health" grafana
wait_for "$PDF/check-status" grafana-export-to-pdf

echo "== 1. Keycloak -> OTLP -> collector -> Loki"
# Неудачный логин (событие LOGIN_ERROR) и успешный (LOGIN)
curl -s -o /dev/null -d "grant_type=password&client_id=admin-cli&username=admin&password=wrong" \
  "$KC/realms/master/protocol/openid-connect/token"
curl -s -o /dev/null -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" \
  "$KC/realms/master/protocol/openid-connect/token"
sleep 10

if docker compose logs otel-collector 2>/dev/null | grep -q "service.name: Str(keycloak)"; then
  ok "collector получает OTLP-логи от keycloak"
else
  bad "в логах collector нет записей от service.name=keycloak"
fi
if docker compose logs otel-collector 2>/dev/null | grep -q "LOGIN_ERROR"; then
  ok "событие LOGIN_ERROR дошло до collector"
else
  bad "LOGIN_ERROR не найден в collector"
fi

start=$(( $(date +%s) - 3600 ))000000000
loki_q() {
  curl -s -G "http://localhost:3100/loki/api/v1/query_range" \
    --data-urlencode "query=$1" --data-urlencode "start=$start" --data-urlencode "limit=1000"
}
n=$(loki_q '{service_name="keycloak"}' | python -c "import sys,json;print(sum(len(s['values']) for s in json.load(sys.stdin)['data']['result']))")
[ "${n:-0}" -gt 0 ] && ok "в Loki $n записей {service_name=\"keycloak\"}" || bad "в Loki нет логов keycloak"
n=$(loki_q '{service_name="keycloak"} |= "type=\"LOGIN\""' | python -c "import sys,json;print(sum(len(s['values']) for s in json.load(sys.stdin)['data']['result']))")
[ "${n:-0}" -gt 0 ] && ok "событие LOGIN найдено в Loki ($n)" || bad "событие LOGIN не найдено в Loki"

echo "== 2. Grafana Infinity datasource"
ver=$(curl -s -u admin:admin "$GF/api/plugins/yesoreyeram-infinity-datasource/settings" | python -c "import sys,json;print(json.load(sys.stdin)['info']['version'])" 2>/dev/null)
[ -n "$ver" ] && ok "плагин установлен, версия $ver" || bad "плагин Infinity не установлен"

health=$(curl -s -u admin:admin "$GF/api/datasources/uid/infinity/health")
echo "$health" | grep -q '"status":"OK"' && ok "health check datasource: OK" || bad "health check: $health"

ds_query() { # json target
  curl -s -u admin:admin -H "Content-Type: application/json" "$GF/api/ds/query" \
    -d "{\"from\":\"now-1h\",\"to\":\"now\",\"queries\":[$1]}"
}
rows() { python -c "import sys,json;f=json.load(sys.stdin)['results']['A']['frames'][0];print(len(f['data']['values'][0]))" 2>/dev/null; }
r=$(ds_query '{"refId":"A","datasource":{"uid":"infinity"},"type":"json","source":"url","format":"table","parser":"backend","url":"http://mock-api/users.json","url_options":{"method":"GET"}}' | rows)
[ "$r" = "4" ] && ok "JSON-запрос вернул $r строк" || bad "JSON-запрос: ожидалось 4 строки, получено '${r}'"
r=$(ds_query '{"refId":"A","datasource":{"uid":"infinity"},"type":"csv","source":"url","format":"table","parser":"backend","url":"http://mock-api/sales.csv","url_options":{"method":"GET"}}' | rows)
[ "$r" = "6" ] && ok "CSV-запрос вернул $r строк" || bad "CSV-запрос: ожидалось 6 строк, получено '${r}'"
r=$(ds_query '{"refId":"A","datasource":{"uid":"infinity"},"type":"json","source":"url","format":"table","parser":"backend","url":"http://example.com/","url_options":{"method":"GET"}}')
echo "$r" | grep -qi "not allowed\|allowed hosts" && ok "запрос к хосту вне allowedHosts отклонён" || bad "allowedHosts не сработал: $(echo "$r" | head -c 200)"

echo "== 3. grafana-export-to-pdf"
resp=$(curl -s -m 180 -H "Content-Type: application/json" -X POST \
  -d '{"url":"http://localhost:3000/d/tech/tech-stand","from":"now-1h","to":"now"}' "$PDF/generate-pdf")
url=$(echo "$resp" | python -c "import sys,json;print(json.load(sys.stdin)['pdfUrl'])" 2>/dev/null)
if [ -n "$url" ]; then
  curl -s -o output/test.pdf "$url"
  magic=$(head -c 5 output/test.pdf)
  size=$(wc -c < output/test.pdf)
  [ "$magic" = "%PDF-" ] && ok "PDF получен: $url ($size байт) -> output/test.pdf" || bad "файл не PDF: $url"
else
  bad "generate-pdf ответил: $(echo "$resp" | head -c 300)"
fi

echo
[ $fail -eq 0 ] && echo "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" || echo "ЕСТЬ ОШИБКИ"
exit $fail
