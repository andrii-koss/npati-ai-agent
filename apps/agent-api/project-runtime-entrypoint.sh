#!/bin/sh
set -eu
umask 077
/usr/local/bin/npati-project-exec --check
mkdir -p /projects /runtime-state
chmod 711 /projects
chmod 700 /runtime-state
# Only the trusted supervisor/proxy UID may open external connections. Project
# UIDs can reach the in-container allowlisted proxy and their own assigned port.
# Initialize isolation chains
for firewall in iptables ip6tables; do
  "$firewall" -N NPATI_PROJECTS 2>/dev/null || "$firewall" -F NPATI_PROJECTS
  "$firewall" -N NPATI_EGRESS_RESTRICT 2>/dev/null || "$firewall" -F NPATI_EGRESS_RESTRICT
  "$firewall" -C OUTPUT -j NPATI_EGRESS_RESTRICT 2>/dev/null || "$firewall" -I OUTPUT 1 -j NPATI_EGRESS_RESTRICT
  "$firewall" -C OUTPUT -m owner --uid-owner 10000-60000 -j NPATI_PROJECTS 2>/dev/null || "$firewall" -I OUTPUT 1 -m owner --uid-owner 10000-60000 -j NPATI_PROJECTS
  "$firewall" -A NPATI_PROJECTS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
iptables -A NPATI_PROJECTS -p tcp --dport 7865 -j REJECT --reject-with icmp-port-unreachable
iptables -A NPATI_PROJECTS -p tcp -d 127.0.0.1 --dport 8080 -j ACCEPT
iptables -A NPATI_PROJECTS -j REJECT --reject-with icmp-port-unreachable
ip6tables -A NPATI_PROJECTS -j REJECT --reject-with icmp6-port-unreachable

# Defense-in-depth: Global egress restrictions across ALL UIDs (including root and nobody)
iptables -A NPATI_EGRESS_RESTRICT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A NPATI_EGRESS_RESTRICT -o lo -j ACCEPT
iptables -A NPATI_EGRESS_RESTRICT -p tcp -m multiport --dports 5432,6379,9000,9001,20128,20129,11235,8765 -j REJECT --reject-with icmp-port-unreachable
# RFC 1918 Private networks
iptables -A NPATI_EGRESS_RESTRICT -d 10.0.0.0/8 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 172.16.0.0/12 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 192.168.0.0/16 -j REJECT --reject-with icmp-net-unreachable
# RFC 3927 Link-local / Cloud metadata
iptables -A NPATI_EGRESS_RESTRICT -d 169.254.0.0/16 -j REJECT --reject-with icmp-net-unreachable
# RFC 6598 Carrier-grade NAT
iptables -A NPATI_EGRESS_RESTRICT -d 100.64.0.0/10 -j REJECT --reject-with icmp-net-unreachable
# RFC 1122 Current network / Loopback on non-lo
iptables -A NPATI_EGRESS_RESTRICT -d 0.0.0.0/8 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 127.0.0.0/8 -j REJECT --reject-with icmp-net-unreachable
# RFC 6890 / RFC 5737 / RFC 2544 Special & benchmark networks
iptables -A NPATI_EGRESS_RESTRICT -d 192.0.0.0/24 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 192.0.2.0/24 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 198.18.0.0/15 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 198.51.100.0/24 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 203.0.113.0/24 -j REJECT --reject-with icmp-net-unreachable
# RFC 5771 Multicast & RFC 1112 Reserved
iptables -A NPATI_EGRESS_RESTRICT -d 224.0.0.0/4 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 240.0.0.0/4 -j REJECT --reject-with icmp-net-unreachable
iptables -A NPATI_EGRESS_RESTRICT -d 255.255.255.255/32 -j REJECT --reject-with icmp-net-unreachable

# Global IPv6 egress restrictions (reject all non-loopback IPv6 traffic)
ip6tables -N NPATI_EGRESS_RESTRICT 2>/dev/null || ip6tables -F NPATI_EGRESS_RESTRICT
ip6tables -C OUTPUT -j NPATI_EGRESS_RESTRICT 2>/dev/null || ip6tables -I OUTPUT 1 -j NPATI_EGRESS_RESTRICT
ip6tables -A NPATI_EGRESS_RESTRICT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A NPATI_EGRESS_RESTRICT -o lo -j ACCEPT
ip6tables -A NPATI_EGRESS_RESTRICT -j REJECT --reject-with icmp6-port-unreachable

# The shared npm cache lives on the projects disk so that projects can hard-link it.
seed_source=/opt/npati-project-toolchain/npm-cache
seed=/projects/.npm-seed
if [ -f "$seed_source/.stamp" ] && ! cmp -s "$seed_source/.stamp" "$seed/.complete"; then
  (
    rm -rf "$seed" "$seed.tmp"
    cp -R "$seed_source" "$seed.tmp"
    chmod -R a+rX,go-w "$seed.tmp"
    cp "$seed_source/.stamp" "$seed.tmp/.complete"
    mv "$seed.tmp" "$seed"
  ) &
fi

# One read-only copy of each prepared set on the projects disk: a project hard-links it in about a second.
(
  stamp=/opt/npati-project-toolchain/npm-cache/.stamp
  for profile in /opt/npati-project-toolchain/*/node_modules; do
    name=$(basename "$(dirname "$profile")")
    case "$name" in npm-cache) continue;; esac
    target="/projects/.modules-seed/$name"
    if [ -f "$stamp" ] && cmp -s "$stamp" "$target/.complete"; then continue; fi
    rm -rf "$target" "$target.tmp"
    mkdir -p "$target.tmp"
    cp -R "$profile" "$target.tmp/node_modules"
    chmod -R a+rX,go-w "$target.tmp"
    if [ -f "$stamp" ]; then cp "$stamp" "$target.tmp/.complete"; else date > "$target.tmp/.complete"; fi
    mv "$target.tmp" "$target"
  done
  chmod 755 /projects/.modules-seed 2>/dev/null || true
) &

# The Flutter SDK on the projects disk, for the same reason.
(
  if [ -x /opt/flutter/bin/flutter ] && ! cmp -s /opt/flutter/bin/cache/flutter_tools.stamp /projects/.flutter-sdk/.complete; then
    rm -rf /projects/.flutter-sdk /projects/.flutter-sdk.tmp
    mkdir -p /projects/.flutter-sdk.tmp
    cp -R --preserve=mode,timestamps --no-preserve=ownership /opt/flutter /projects/.flutter-sdk.tmp/flutter
    chmod -R a+rX,go-w /projects/.flutter-sdk.tmp
    cp /opt/flutter/bin/cache/flutter_tools.stamp /projects/.flutter-sdk.tmp/.complete
    mv /projects/.flutter-sdk.tmp /projects/.flutter-sdk
  fi
) &

# Reading prepared modules from a cold image took minutes on the first project after a start.
( find /opt/npati-project-toolchain -type f -not -path "*/npm-cache/*" -exec cat {} + > /dev/null 2>&1 ) &

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
