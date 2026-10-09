#!/bin/sh
set -eu
umask 077
/usr/local/bin/npati-project-exec --check
mkdir -p /projects /runtime-state
chmod 711 /projects
chmod 700 /runtime-state
# Only the trusted supervisor/proxy UID may open external connections. Project
# UIDs can reach the in-container allowlisted proxy and their own assigned port.
for firewall in iptables ip6tables; do
  "$firewall" -N NPATI_PROJECTS 2>/dev/null || "$firewall" -F NPATI_PROJECTS
  "$firewall" -C OUTPUT -m owner --uid-owner 10000-60000 -j NPATI_PROJECTS 2>/dev/null || "$firewall" -I OUTPUT -m owner --uid-owner 10000-60000 -j NPATI_PROJECTS
  "$firewall" -A NPATI_PROJECTS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
iptables -A NPATI_PROJECTS -p tcp -d 127.0.0.1 --dport 8080 -j ACCEPT
# Landlock additionally limits loopback connections/binds to the project's port.
iptables -A NPATI_PROJECTS -p tcp -d 127.0.0.1 -j ACCEPT
ip6tables -A NPATI_PROJECTS -p tcp -d ::1 -j ACCEPT
iptables -A NPATI_PROJECTS -j REJECT
ip6tables -A NPATI_PROJECTS -j REJECT
node /opt/npati-runtime/sandbox-egress-proxy.mjs &
proxy_pid=$!
node /app/dist/shared-project-runtime-server.js &
runner_pid=$!
trap 'kill "$runner_pid" "$proxy_pid" 2>/dev/null || true; wait; exit 0' TERM INT
# A crashed supervisor or proxy makes the container restart as a unit.
while kill -0 "$runner_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do sleep 1; done
kill "$runner_pid" "$proxy_pid" 2>/dev/null || true
wait || true
exit 1
