#!/bin/bash
#
# Cron de cacheo de fuentes (vzla-finder).
#
# Refresca TODAS las fuentes registradas. runAll() hace requests condicionales
# (ETag / Last-Modified / hash), así que si una fuente no cambió NO se re-ingiere:
# correrlo cada 15 min es barato y cortés con cada silo.
#
# Pensado para cPanel / CloudLinux (Node.js Selector). Crontab sugerido:
#   */15 * * * * /home/USUARIO/vzla-finder/scripts/cron-ingest.sh
#
# Variables de entorno opcionales:
#   APP_ROOT   raíz de la app        (default: el padre de este script)
#   NODE_BIN   binario de node       (default: alt-nodejs24 de CloudLinux)
#   VZLA_DB    ruta de la base SQLite (default: $APP_ROOT/data.db)
#
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/alt/alt-nodejs24/root/usr/bin/node}"
export VZLA_DB="${VZLA_DB:-$APP_ROOT/data.db}"

LOG_DIR="$APP_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ingest.log"
LOCK="$LOG_DIR/ingest.lock"

# Evitar solapamiento si una corrida tarda más que el intervalo del cron.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) [skip] ya hay una ingesta en curso" >> "$LOG"
  exit 0
fi

cd "$APP_ROOT"
echo "$(date -Is) [start] ingesta" >> "$LOG"

# Node 24: node:sqlite es estable; el flag se acepta igual por compatibilidad
# con los scripts de package.json.
if "$NODE_BIN" --experimental-sqlite --import tsx src/cli.ts ingest >> "$LOG" 2>&1; then
  echo "$(date -Is) [ok] ingesta completa" >> "$LOG"
else
  rc=$?
  echo "$(date -Is) [error] ingesta fallida (rc=$rc)" >> "$LOG"
fi

# Rotación simple: mantener el log por debajo de ~2 MB.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
