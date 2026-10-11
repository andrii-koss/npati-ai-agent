FROM node:24-alpine AS project-web-toolchain
RUN apk add --no-cache python3 git build-base
COPY apps/agent-api/project-runtime-profiles.json apps/agent-api/build-project-runtime-profiles.cjs /tmp/npati-toolchain/
RUN --mount=type=cache,id=npati-project-web-npm,target=/root/.npm node /tmp/npati-toolchain/build-project-runtime-profiles.cjs

FROM node:24-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages ./packages
RUN npm ci
RUN npm run build --workspace @npati/web

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
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
COPY apps/agent-api/src/sandbox-egress-proxy.mjs /opt/npati-sandbox-images/src/
COPY apps/agent-api/sandbox-runner-entrypoint.sh /opt/npati-sandbox-images/entrypoint.sh
EXPOSE 7865
CMD ["sh", "/opt/npati-sandbox-images/entrypoint.sh"]

FROM runtime-base AS runtime
ENV NPATI_WEB_DIST_DIR=/app/web
COPY --from=web-build /app/apps/web/dist ./web
# Session branch admission/checkpoints execute Git in the API/worker workspace,
# before project commands are dispatched to the shared runtime.
RUN apk add --no-cache postgresql-client git && git --version
RUN mkdir -p /app/data /app/project-snapshots && chown node:node /app/data /app/project-snapshots
EXPOSE 3001
USER node
CMD ["node", "dist/server.js"]

# OSS shared project runtime: no Docker CLI/socket, one container for all projects.
FROM node:24-alpine AS project-runtime-tools
USER root
ENV NPATI_SANDBOX_RUNNER_MODE=local
RUN apk add --no-cache python3 py3-pip git openssh-client ripgrep build-base linux-headers bash coreutils findutils util-linux procps jq unzip curl iptables
RUN npm install -g --prefix /opt/npati-package-managers --no-audit --no-fund pnpm@10 yarn@1.22.22
COPY --from=project-web-toolchain /opt/npati-project-toolchain /opt/npati-project-toolchain
COPY apps/agent-api/prepare-project-dependencies.cjs /opt/npati-runtime/prepare-project-dependencies.cjs
COPY apps/agent-api/project-runtime-guard.c /tmp/project-runtime-guard.c
RUN cc -O2 -Wall -Wextra -Werror /tmp/project-runtime-guard.c -o /usr/local/bin/npati-project-exec && rm /tmp/project-runtime-guard.c
COPY apps/agent-api/src/sandbox-egress-proxy.mjs /opt/npati-runtime/sandbox-egress-proxy.mjs
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
