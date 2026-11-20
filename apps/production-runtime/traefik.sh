#!/bin/sh
set -eu
set -- \
  --entrypoints.web.address=:8080 \
  --entrypoints.websecure.address=:8443 \
  --entrypoints.web.transport.respondingtimeouts.readtimeout=35s \
  --entrypoints.websecure.transport.respondingtimeouts.readtimeout=35s \
  --providers.file.directory=/routes \
  --providers.file.watch=true \
  --log.level=INFO
if [ -n "${NPATI_PRODUCTION_ACME_EMAIL:-}" ]; then
  set -- "$@" \
    --certificatesresolvers.npati.acme.email="$NPATI_PRODUCTION_ACME_EMAIL" \
    --certificatesresolvers.npati.acme.storage=/certs/acme.json \
    --certificatesresolvers.npati.acme.httpchallenge.entrypoint=web
fi
exec traefik "$@"
