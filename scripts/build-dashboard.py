"""Собирает grafana/dashboards/tech.json, встраивая grafana/grafana-button.html в text-панель."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
button_html = (root / "grafana" / "grafana-button.html").read_text(encoding="utf-8")

loki = {"type": "loki", "uid": "loki"}
infinity = {"type": "yesoreyeram-infinity-datasource", "uid": "infinity"}

dashboard = {
    "uid": "tech",
    "title": "Tech stand",
    "schemaVersion": 41,
    "time": {"from": "now-1h", "to": "now"},
    "refresh": "",
    "panels": [
        {
            "id": 1,
            "type": "text",
            "title": "Export to PDF",
            "gridPos": {"x": 0, "y": 0, "w": 24, "h": 3},
            "options": {"mode": "html", "content": button_html},
        },
        {
            "id": 2,
            "type": "logs",
            "title": "Keycloak logs (OTLP -> Loki)",
            "datasource": loki,
            "gridPos": {"x": 0, "y": 3, "w": 24, "h": 10},
            "targets": [{"refId": "A", "datasource": loki, "expr": '{service_name="keycloak"}'}],
        },
        {
            "id": 3,
            "type": "table",
            "title": "Infinity: users.json",
            "datasource": infinity,
            "gridPos": {"x": 0, "y": 13, "w": 12, "h": 8},
            "targets": [{
                "refId": "A", "datasource": infinity,
                "type": "json", "source": "url", "format": "table", "parser": "backend",
                "url": "http://mock-api/users.json", "url_options": {"method": "GET"},
                "root_selector": "", "columns": [],
            }],
        },
        {
            "id": 4,
            "type": "barchart",
            "title": "Infinity: sales.csv",
            "datasource": infinity,
            "gridPos": {"x": 12, "y": 13, "w": 12, "h": 8},
            "targets": [{
                "refId": "A", "datasource": infinity,
                "type": "csv", "source": "url", "format": "table", "parser": "backend",
                "url": "http://mock-api/sales.csv", "url_options": {"method": "GET"},
                "columns": [
                    {"selector": "month", "text": "month", "type": "string"},
                    {"selector": "region", "text": "region", "type": "string"},
                    {"selector": "amount", "text": "amount", "type": "number"},
                ],
            }],
        },
    ],
}

out = root / "grafana" / "dashboards" / "tech.json"
out.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"written {out}")
