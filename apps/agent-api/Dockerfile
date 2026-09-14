FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/agent-api ./apps/agent-api
COPY packages ./packages
RUN apk add --no-cache python3 make g++
RUN npm ci
RUN npm run build --workspace @npati/agent-api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/apps/agent-api/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 3001
USER node
CMD ["node", "dist/server.js"]
