#!/bin/sh
# Read-only VPS inspection. Usage: sh scripts/ops/inspect-sandbox-runner.sh RUNNER_CONTAINER AGENT_API_CONTAINER COMPANY_WORKER_CONTAINER [SANDBOX_ID]
set -eu
runner=${1:?runner container name required}
api=${2:?agent-api container name required}
worker=${3:?company-worker container name required}
sandbox_id=${4:-}

echo 'Runner identity and Docker socket mount:'
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{.Source}} -> {{.Destination}} ({{.Type}}){{end}}{{end}}' "$runner"
docker exec "$runner" sh -c 'id; ls -l /var/run/docker.sock; test -S /var/run/docker.sock'
echo 'Docker CLI and daemon from inside runner:'
docker exec "$runner" docker version
docker exec "$runner" docker info --format 'ServerVersion={{.ServerVersion}} Driver={{.Driver}} SecurityOptions={{.SecurityOptions}}'
echo 'Expected and available images:'
docker exec "$runner" sh -c 'printf "project-sandbox="; docker image inspect "${NPATI_SANDBOX_IMAGE:-npati/project-sandbox:local}" --format "{{.Id}}"; printf "sandbox-egress="; docker image inspect "${NPATI_SANDBOX_EGRESS_IMAGE:-npati/sandbox-egress:local}" --format "{{.Id}}"; docker image ls --format "{{.Repository}}:{{.Tag}}"'
echo 'Docker networks:'
docker exec "$runner" docker network ls --format '{{.Name}}'
secret_hash() {
  docker exec "$1" node -e 'const s=process.env.NPATI_SANDBOX_RUNNER_SECRET||"";if(s.length<32)process.exit(2);process.stdout.write(require("node:crypto").createHash("sha256").update(s).digest("hex"))'
}
a=$(secret_hash "$api")
w=$(secret_hash "$worker")
r=$(secret_hash "$runner")
if [ "$a" = "$w" ] && [ "$w" = "$r" ]; then echo 'Runner secrets: equal and at least 32 characters'; else echo 'Runner secrets: MISMATCH' >&2; exit 1; fi
docker exec "$api" node -e 'console.log("agent-api mode="+process.env.NPATI_SANDBOX_RUNNER_MODE+" urlOrigin="+(process.env.NPATI_SANDBOX_RUNNER_URL?new URL(process.env.NPATI_SANDBOX_RUNNER_URL).origin:"unset"))'
docker exec "$worker" node -e 'console.log("company-worker mode="+process.env.NPATI_SANDBOX_RUNNER_MODE+" urlOrigin="+(process.env.NPATI_SANDBOX_RUNNER_URL?new URL(process.env.NPATI_SANDBOX_RUNNER_URL).origin:"unset"))'
if [ -n "$sandbox_id" ]; then
  case "$sandbox_id" in *[!a-fA-F0-9-]*|'') echo 'Invalid sandbox ID' >&2; exit 2;; esac
  echo 'Sandbox container and workspace:'
  docker exec "$runner" docker inspect --format 'Name={{.Name}} Image={{.Config.Image}} State={{.State.Status}} Networks={{json .NetworkSettings.Networks}} Mounts={{json .Mounts}}' "npati-sb-$sandbox_id"
  docker exec "$runner" docker exec "npati-sb-$sandbox_id" sh -c 'id; pwd; test -w /workspace; ls -la /workspace | head -30'
fi
