#!/usr/bin/env bash
# Готовит комплект для среды без интернета (запускать на машине С интернетом):
#   ./scripts/offline-bundle.sh            -> offline-bundle.tar.gz
# На целевой машине:
#   tar xzf offline-bundle.tar.gz && cd tech
#   docker load -i offline/images.tar
#   docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
set -euo pipefail
cd "$(dirname "$0")/.."

INFINITY_VERSION=${INFINITY_VERSION:-3.11.1}
OS_ARCH=${OS_ARCH:-linux-amd64}   # linux-arm64 для ARM-серверов

echo "== Плагин Infinity $INFINITY_VERSION ($OS_ARCH)"
zip="offline/infinity-$INFINITY_VERSION.$OS_ARCH.zip"
mkdir -p offline
curl -sfL -o "$zip" \
  "https://grafana.com/api/plugins/yesoreyeram-infinity-datasource/versions/$INFINITY_VERSION/download?os=${OS_ARCH%-*}&arch=${OS_ARCH#*-}"
rm -rf offline/plugins && mkdir -p offline/plugins
unzip -q "$zip" -d offline/plugins
chmod +x offline/plugins/yesoreyeram-infinity-datasource/gpx_infinity_*

echo "== Docker-образы"
docker compose build
images=$(docker compose config --images)
for i in $images; do docker image inspect "$i" >/dev/null 2>&1 || docker pull "$i"; done
docker save -o offline/images.tar $images

echo "== Архив"
tar czf ../offline-bundle.tar.gz --exclude=.git --exclude=output -C .. "$(basename "$PWD")"
ls -lh ../offline-bundle.tar.gz
