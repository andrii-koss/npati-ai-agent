#!/bin/sh
set -eu

image_dir=/opt/npati-sandbox-images
export DOCKER_BUILDKIT=1
project_image=${NPATI_SANDBOX_IMAGE:-npati/project-sandbox:local}
egress_image=${NPATI_SANDBOX_EGRESS_IMAGE:-npati/sandbox-egress:local}

runner_secret=${NPATI_SANDBOX_RUNNER_SECRET:-}
if [ "${#runner_secret}" -lt 32 ]; then
  echo "Sandbox runner requires NPATI_SANDBOX_RUNNER_SECRET with at least 32 characters (also set it on API and worker)" >&2
  exit 1
fi

# Production consumes published, immutable images; it must not build mutable tags
# during application startup. Development bootstrap remains explicit below.
development=false
if [ "${NPATI_ENVIRONMENT:-}" = development ] && [ "${NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES:-}" = true ]; then development=true; fi
if [ "$development" = false ]; then
  for image in "$project_image" "$egress_image"; do
    case "$image" in
      *@sha256:*) ;;
      *) echo "Production sandbox images must use registry/image@sha256:<digest>; configure NPATI_SANDBOX_IMAGE and NPATI_SANDBOX_EGRESS_IMAGE using published images" >&2; exit 1 ;;
    esac
    if ! docker image inspect "$image" >/dev/null 2>&1; then docker pull "$image"; fi
  done
  exec node /app/dist/sandbox-runner-server.js
fi

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
