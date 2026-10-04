FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/agent-api ./apps/agent-api
COPY packages ./packages
RUN apk add --no-cache python3 make g++
RUN npm ci
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

FROM runtime-base AS sandbox-runner
USER root
RUN apk add --no-cache docker-cli
EXPOSE 7865
CMD ["node", "dist/sandbox-runner-server.js"]

FROM runtime-base AS runtime
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 3001
USER node
CMD ["node", "dist/server.js"]
