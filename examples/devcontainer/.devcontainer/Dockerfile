FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.6.0

WORKDIR /workspaces/devcontainer-demo
