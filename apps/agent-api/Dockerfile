FROM node:24-alpine AS project-web-toolchain
RUN apk add --no-cache python3 git build-base
COPY apps/agent-api/build-project-runtime-npm-cache.cjs apps/agent-api/project-runtime-profiles.json apps/agent-api/build-project-runtime-profiles.cjs apps/agent-api/src/project-framework-locks.json /tmp/npati-toolchain/
RUN --mount=type=cache,id=npati-project-web-npm,target=/root/.npm node /tmp/npati-toolchain/build-project-runtime-profiles.cjs
RUN node /tmp/npati-toolchain/build-project-runtime-npm-cache.cjs

FROM node:24-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts/patch-minio-jsonl.mjs ./scripts/patch-minio-jsonl.mjs
COPY apps/web ./apps/web
COPY packages ./packages
RUN npm ci
RUN npm run build --workspace @npati/web

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts/patch-minio-jsonl.mjs ./scripts/patch-minio-jsonl.mjs
COPY apps/agent-api/package.json ./apps/agent-api/package.json
COPY packages ./packages
RUN apk add --no-cache python3 make g++
RUN npm ci
COPY apps/agent-api ./apps/agent-api
RUN npm run build --workspace @npati/agent-api
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime-base
ARG NPATI_BUILD_COMMIT=unknown
ARG NPATI_BUILD_TIME=unknown
ENV NODE_ENV=production NPATI_BUILD_COMMIT=${NPATI_BUILD_COMMIT} NPATI_BUILD_TIME=${NPATI_BUILD_TIME}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
# npm may keep native workspace dependencies (notably better-sqlite3) under
# the workspace instead of hoisting them to the repository root.
COPY --from=build /app/apps/agent-api/node_modules ./node_modules
COPY --from=build /app/apps/agent-api/dist ./dist
# The Project API client is vendored into Project workspaces (D5); ship its source for runtime use.
COPY --from=build /app/packages/project-client/src/index.ts /opt/npati-project-sdk/index.ts

FROM runtime-base AS sandbox-runner
USER root
ENV DOCKER_CONFIG=/tmp/npati-docker NPATI_SANDBOX_IMAGE_CATALOG=/opt/npati-sandbox-images/catalog.json
RUN apk add --no-cache docker-cli docker-cli-buildx cosign
COPY docker/sandbox/images.json /opt/npati-sandbox-images/catalog.json
COPY apps/agent-api/Dockerfile.project-sandbox apps/agent-api/Dockerfile.sandbox-egress /opt/npati-sandbox-images/
COPY apps/agent-api/src/sandbox-egress-proxy.mjs apps/agent-api/src/sandbox-project-api-binding.mjs /opt/npati-sandbox-images/src/
COPY apps/agent-api/sandbox-runner-entrypoint.sh /opt/npati-sandbox-images/entrypoint.sh
EXPOSE 7865
CMD ["sh", "/opt/npati-sandbox-images/entrypoint.sh"]

FROM runtime-base AS runtime
ENV NPATI_WEB_DIST_DIR=/app/web
COPY --from=web-build /app/apps/web/dist ./web
# Session branch admission/checkpoints execute Git in the API/worker workspace,
# before project commands are dispatched to the shared runtime.
RUN apk add --no-cache postgresql-client git util-linux && git --version && flock --version
RUN mkdir -p /app/data /app/project-snapshots && chown node:node /app/data /app/project-snapshots
EXPOSE 3001
USER node
CMD ["node", "dist/server.js"]

# OSS shared project runtime: no Docker CLI/socket, one container for all projects.
FROM debian:bookworm-slim AS project-flutter-sdk
COPY apps/agent-api/prepare-flutter-sdk.sh /tmp/prepare-flutter-sdk.sh
RUN sh /tmp/prepare-flutter-sdk.sh

FROM node:24-alpine AS project-runtime-tools
USER root
ENV NPATI_SANDBOX_RUNNER_MODE=local
RUN apk add --no-cache python3 py3-pip git openssh-client ripgrep build-base linux-headers bash coreutils findutils util-linux procps jq unzip curl iptables bubblewrap slirp4netns \
  php83 php83-phar php83-mbstring php83-openssl php83-tokenizer php83-xml php83-xmlwriter php83-dom php83-simplexml \
  php83-ctype php83-fileinfo php83-session php83-curl php83-pdo php83-pdo_sqlite php83-sqlite3 php83-bcmath php83-iconv composer \
  && ln -sf /usr/bin/php83 /usr/local/bin/php
RUN npm install -g --prefix /opt/npati-package-managers --no-audit --no-fund pnpm@10 yarn@1.22.22
COPY --from=project-web-toolchain /opt/npati-project-toolchain /opt/npati-project-toolchain
COPY apps/agent-api/prepare-project-dependencies.cjs /opt/npati-runtime/prepare-project-dependencies.cjs
COPY apps/agent-api/project-runtime-composer.sh /usr/local/bin/composer
RUN chmod +x /usr/local/bin/composer
COPY --from=project-flutter-sdk /opt/flutter /opt/flutter
COPY --from=project-flutter-sdk /opt/flutter-glibc /opt/flutter-glibc
COPY apps/agent-api/project-runtime-flutter.sh /usr/local/bin/flutter
RUN chmod 755 /usr/local/bin/flutter && ln -sf flutter /usr/local/bin/dart
COPY apps/agent-api/project-runtime-guard.c /tmp/project-runtime-guard.c
COPY apps/agent-api/project-runtime-launcher.mjs apps/agent-api/project-runtime-inner.mjs /opt/npati-runtime/
RUN apk add --no-cache libseccomp-dev chromium font-noto
# Pygame has no musl wheel on PyPI; the distribution build runs here. Xvfb and xdotool let the automatic check play a desktop game.
RUN apk add --no-cache py3-pygame xvfb xdotool
# Native Android builds (APK/AAB) for chat-made mobile apps: JDK 17 and the Android SDK (platform 36, build-tools 36, NDK
# 28.2 that Flutter 3.47 pins). The SDK's native tools are glibc builds; gcompat runs them here. The launcher mounts it read-only.
RUN apk add --no-cache openjdk17-jdk gcompat bash unzip
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p /opt/android-sdk/cmdline-tools && cd /tmp \
  && wget -q -O tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
  && unzip -q tools.zip -d /opt/android-sdk/cmdline-tools && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest && rm tools.zip \
  && (yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null) \
  && /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;28.2.13676358" >/dev/null \
  && chmod -R a+rX /opt/android-sdk
RUN npm install --prefix /opt/npati-qa --omit=dev --ignore-scripts --no-audit --no-fund playwright@1.63.0
COPY apps/agent-api/browser-qa-runner.mjs /opt/npati-qa/browser-qa-runner.mjs
COPY apps/agent-api/browser-qa-actions.mjs /opt/npati-qa/browser-qa-actions.mjs
COPY apps/agent-api/browser-qa-diagnostics.mjs /opt/npati-qa/browser-qa-diagnostics.mjs
COPY apps/agent-api/pygame-smoke.sh apps/agent-api/pygame-stream.py /opt/npati-qa/
RUN cc -O2 -Wall -Wextra -Werror /tmp/project-runtime-guard.c -lseccomp -o /usr/local/bin/npati-project-exec \
  && /usr/local/bin/npati-project-exec --emit-filter /opt/npati-runtime/project-command.seccomp \
  && rm /tmp/project-runtime-guard.c
COPY apps/agent-api/src/sandbox-egress-proxy.mjs /opt/npati-runtime/sandbox-egress-proxy.mjs
COPY apps/agent-api/src/sandbox-project-api-binding.mjs /opt/npati-runtime/sandbox-project-api-binding.mjs
COPY apps/agent-api/project-runtime-entrypoint.sh /opt/npati-runtime/entrypoint.sh
RUN mkdir -p /projects /runtime-state && chmod 711 /projects && chmod 700 /runtime-state
EXPOSE 7865
CMD ["sh", "/opt/npati-runtime/entrypoint.sh"]

# Keep the large prepared toolchain independent of API source rebuilds.
FROM project-runtime-tools AS project-runtime
ARG NPATI_BUILD_COMMIT=unknown
ARG NPATI_BUILD_TIME=unknown
ENV NODE_ENV=production NPATI_BUILD_COMMIT=${NPATI_BUILD_COMMIT} NPATI_BUILD_TIME=${NPATI_BUILD_TIME}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/agent-api/node_modules ./node_modules
COPY --from=build /app/apps/agent-api/dist ./dist
