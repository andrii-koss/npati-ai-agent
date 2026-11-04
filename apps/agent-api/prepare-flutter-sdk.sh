#!/bin/sh
# Builds a Flutter SDK for the Alpine project runtime. Flutter needs glibc, so its binaries are pointed at a private
# copy of glibc in /opt/flutter-glibc. Runs in a Debian build stage and leaves the result in /opt.
set -e
export DEBIAN_FRONTEND=noninteractive PATH=/opt/flutter/bin:$PATH FLUTTER_SUPPRESS_ANALYTICS=true CI=true
if [ ! -x /opt/flutter/bin/flutter ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends curl ca-certificates git xz-utils unzip patchelf file jq > /dev/null
  base=https://storage.googleapis.com/flutter_infra_release/releases
  releases=$(curl -fsSL "$base/releases_linux.json")
  hash=$(echo "$releases" | jq -r .current_release.stable)
  archive=$(echo "$releases" | jq -r --arg h "$hash" '.releases[] | select(.hash == $h) | .archive')
  curl -fsSL "$base/$archive" | tar -xJ -C /opt
  git config --global --add safe.directory '*'
  flutter config --no-analytics > /dev/null
  flutter config --enable-web > /dev/null
  flutter precache --web --no-android --no-ios --no-linux --no-windows --no-macos --no-fuchsia
fi
# flutter_tools.stamp must stay valid, so everything Flutter checks is left in place and only unused parts are removed.
cd /opt/flutter
rm -rf examples docs engine third_party .github .idea .vscode .claude .gemini .agents agent-artifacts dev/integration_tests dev/benchmarks dev/devicelab dev/tracing_tests dev/manual_tests dev/a11y_assessments
rm -rf bin/cache/downloads
glibc=/opt/flutter-glibc
mkdir -p "$glibc"
for library in ld-linux-x86-64.so.2 libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 libresolv.so.2 libnss_dns.so.2 libnss_files.so.2; do
  source=$(find /lib /usr/lib -name "$library" 2>/dev/null | head -1)
  [ -n "$source" ] && cp -L "$source" "$glibc/"
done
for library in libstdc++.so.6 libgcc_s.so.1; do
  source=$(find /lib /usr/lib -name "$library" 2>/dev/null | head -1)
  [ -n "$source" ] && cp -L "$source" "$glibc/"
done
find /opt/flutter/bin/cache -type f -exec file {} + | grep ELF | cut -d: -f1 | while read -r binary; do
  if patchelf --print-interpreter "$binary" > /dev/null 2>&1; then
    patchelf --set-interpreter "$glibc/ld-linux-x86-64.so.2" --set-rpath "$glibc" "$binary"
  else
    patchelf --set-rpath "$glibc" "$binary" 2>/dev/null || true
  fi
done
# /opt is read-only inside a project sandbox; /tmp is private to each command.
rm -f bin/cache/lockfile
ln -s /tmp/.flutter-lockfile bin/cache/lockfile
chmod -R a+rX /opt/flutter "$glibc"
du -sh /opt/flutter "$glibc"
