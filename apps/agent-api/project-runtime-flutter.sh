#!/bin/sh
# Runs Flutter or Dart from the project's own linked SDK. The runner links it before the command starts.
tool=$(basename "$0")
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
export FLUTTER_SUPPRESS_ANALYTICS=true CI=true
[ -n "$HOME" ] && [ -w "$HOME" ] || export HOME="${PWD}/.npati-runtime/home"
mkdir -p "$HOME"
export PUB_CACHE="${PUB_CACHE:-$HOME/.pub-cache}"
sdk="$HOME/../flutter"
[ -x "$sdk/bin/flutter" ] || sdk=/opt/flutter
exec "$sdk/bin/$tool" "$@"
