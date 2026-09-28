# Сборка arthur-mdn/grafana-export-to-pdf из исходников (upstream Dockerfile требует .env в контексте).
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation ca-certificates git jq curl \
    && rm -rf /var/lib/apt/lists/*

ARG GFEXP_REF=0ce30e2362c7bc4166b044ec0a28a6e688e8102c
WORKDIR /usr/src/app
RUN git clone https://github.com/arthur-mdn/grafana-export-to-pdf.git . \
    && git checkout "$GFEXP_REF" \
    && rm -rf .git \
    && touch .env \
    && npm install -g dotenv \
    && PUPPETEER_SKIP_DOWNLOAD=true npm install

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 3001
CMD ["node", "server.js"]
