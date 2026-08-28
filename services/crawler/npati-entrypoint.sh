#!/usr/bin/env bash
set -e
mkdir -p "${NPATI_CRAWLER_STATE_DIR:-/app/npati-state}"
chown -R appuser:appuser "${NPATI_CRAWLER_STATE_DIR:-/app/npati-state}"
exec bash /app/entrypoint.sh