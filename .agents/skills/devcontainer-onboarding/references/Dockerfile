# Dev container image. glibc base (bookworm) for painless Prisma/esbuild/sharp
# native binaries — the prod image can stay Alpine, the dev image favors fewer
# surprises. (GOTCHAS #7)
FROM node:{{NODE}}-bookworm-slim

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    DEBIAN_FRONTEND=noninteractive

# Runtime tools: git (repo ops), openssl/ca-certificates (Prisma + TLS), curl
# (healthchecks), plus procps/util-linux for devrouter's runtime-delivered helper.
# Do not install devrouter packages or helpers in this image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git openssl ca-certificates procps util-linux curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm with npm (not corepack — signature verification can fail on a
# pinned Node). Mirror the repo's pinned version. (GOTCHAS #8)
RUN npm install -g pnpm@{{PNPM}}

# Keep the pnpm store inside the image, off the bind-mounted workspace. (GOTCHAS #9)
RUN pnpm config set store-dir "$PNPM_HOME/.pnpm-store"

WORKDIR /workspaces/{{APP}}
