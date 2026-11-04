#!/bin/sh
# Runs the bundled Flutter or Dart. The SDK is read-only, so its pub cache and settings stay in the project's home.
tool=$(basename "$0")
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
export FLUTTER_SUPPRESS_ANALYTICS=true CI=true
[ -n "$HOME" ] && [ -w "$HOME" ] || export HOME="${PWD}/.npati-runtime/home"
mkdir -p "$HOME"
export PUB_CACHE="${PUB_CACHE:-$HOME/.pub-cache}"
exec "/opt/flutter/bin/$tool" "$@"
