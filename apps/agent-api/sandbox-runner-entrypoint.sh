#!/bin/sh
set -eu

image_dir=/opt/npati-sandbox-images
project_image=${NPATI_SANDBOX_IMAGE:-npati/project-sandbox:local}
egress_image=${NPATI_SANDBOX_EGRESS_IMAGE:-npati/sandbox-egress:local}

echo "[sandbox-runner-image] building project sandbox image: ${project_image}"
docker build --file "${image_dir}/Dockerfile.project-sandbox" --tag "${project_image}" "${image_dir}"
echo "[sandbox-runner-image] building egress image: ${egress_image}"
docker build --file "${image_dir}/Dockerfile.sandbox-egress" --tag "${egress_image}" "${image_dir}"

exec node /app/dist/sandbox-runner-server.js