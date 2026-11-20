FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/production
COPY *.mjs *.cjs ./
CMD ["node", "server.mjs"]
