#!/bin/sh
set -eu

image_dir=/opt/npati-sandbox-images
export DOCKER_BUILDKIT=1
project_image=${NPATI_SANDBOX_IMAGE:-npati/project-sandbox:local}
egress_image=${NPATI_SANDBOX_EGRESS_IMAGE:-npati/sandbox-egress:local}

echo "[sandbox-runner-image] checking project sandbox image: ${project_image}"
case "$project_image" in
  *@sha256:*) docker image inspect "$project_image" >/dev/null ;;
  *)
    if ! docker image inspect "$project_image" >/dev/null 2>&1; then
      docker build --file "${image_dir}/Dockerfile.project-sandbox" --tag "$project_image" "$image_dir"
    fi
    pinned_image=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$project_image")
    case "$pinned_image" in
      *@sha256:*) export NPATI_SANDBOX_IMAGE="$pinned_image" ;;
      *)
        if [ "${NPATI_ENVIRONMENT:-}" = development ] && [ "${NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES:-}" = true ]; then
          echo "[sandbox-runner-image] using explicitly permitted local development image"
        else
          echo "Built sandbox has no repository digest; image admission requires a pinned image" >&2
          exit 1
        fi
        ;;
    esac
    ;;
esac
echo "[sandbox-runner-image] checking egress image: ${egress_image}"
if ! docker image inspect "$egress_image" >/dev/null 2>&1; then
  docker build --file "${image_dir}/Dockerfile.sandbox-egress" --tag "${egress_image}" "${image_dir}"
fi

exec node /app/dist/sandbox-runner-server.js
