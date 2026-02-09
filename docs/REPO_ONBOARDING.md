# REPO_ONBOARDING.md

Guide for adapting an existing repository to unified `devrouter` config.

## 1) Purpose

Onboard any repo using one config file:

- `.devrouter.yml`

Supported route types:

- HTTP host-run apps
- HTTP docker apps
- TCP PostgreSQL docker apps (TLS/SNI on shared `:5432`)

Scope:

- no Kubernetes
- no central service registry
- no random host-port URLs for app access

## 2) Before you start

Complete global setup first:

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)

Assumptions:

- `dev` CLI is installed
- `dev up` is already working
- macOS local environment

Reference implementation:

- [`../demo/README.md`](../demo/README.md) shows a complete setup with:
  - host app route
  - docker app route
  - postgres tcp route

## 3) Required per-repo decisions

For each app entry decide:

- `name`
- `host` (`*.localhost`)
- `protocol` (`http` or `tcp`)
- `runtime` (`host` or `docker`)

Host runtime (`http` only):

- `command`
- `cwd`
- `portTimeout` (optional, seconds, default 120)
- optional dependencies

Note: `dev app run` injects `PORT=<free-port>` into the host app environment.
Frameworks reading `PORT` (Next.js, Vite, Remix, etc.) bind to this port automatically.

Docker runtime:

- `service`
- `internalPort`
- `composeFiles`
- optional dependencies
- for TCP, `tcpProtocol=postgres`

Docker compose file guidance:

- Every dependency service **must** define a `healthcheck` (devrouter uses `--wait` to block until healthy)
- Services **must not** publish host ports for devrouter-owned ports (80, 443, 5432)
- Services **should not** publish host ports at all; use devrouter hostnames instead
- `dev app run` waits for deps to become healthy, auto-stops them on exit, and prints recent dep logs

## 4) Fast path

Initialize:

```bash
dev repo init
```

Add host app:

```bash
dev app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd .
```

Add docker Postgres:

```bash
dev app add \
  --name db \
  --host db.localhost \
  --protocol tcp \
  --runtime docker \
  --tcp-protocol postgres \
  --service db \
  --port 5432 \
  --compose-file docker-compose.yml
```

Link dependency and run:

```bash
dev app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd . \
  --depends-on db

dev app run web
```

Use `--yes` for non-interactive runs:

```bash
dev app run web --yes
```

Run one-shot commands (migrations, seeds) with resolved dep env vars:

```bash
dev app exec web --yes -- npx prisma migrate dev
dev app exec web --yes -- npx prisma db seed
```

Current dependency behavior:

- Docker dependencies can be auto-started.
- Host-runtime dependencies are not auto-started in v1 and must be started manually.
- `dev app exec` starts deps, runs a single command with resolved env, then stops deps.

## 5) What changes

Repo file:

- `.devrouter.yml` is updated/maintained.

Global generated state:

- `~/.config/devrouter/cache/.../compose.devrouter.yml`
- `~/.config/devrouter/traefik/dynamic/host-routes.yml`
- `~/.config/devrouter/host-routes-state.json`

No repo-local compose overlay file is required anymore.

## 6) Validation checklist

- `dev app ls` shows expected entries.
- `dev ls` shows both HTTP and/or TCP endpoints.
- `dev doctor --repo <path>` reports no blocking errors.
- HTTP app reachable at `https://<host>.localhost` (after `dev tls install`).
- Postgres route visible as `postgres://<host>.localhost:5432 (tls required)`.
- No duplicate hostnames.

## 7) TLS requirements for Postgres TCP

Postgres hostname multiplexing on one shared `:5432` requires TLS/SNI.

Run:

```bash
dev tls install
```

Client connections should use TLS (for example `sslmode=require`).

Concrete examples:

```bash
psql "host=db.localhost port=5432 dbname=app user=app sslmode=require"
```

```bash
psql "postgresql://app_user:app_pass@db.localhost:5432/app?sslmode=require"
```

## 8) Troubleshooting

Port conflicts:

```bash
lsof -nP -iTCP:80 -sTCP:LISTEN
lsof -nP -iTCP:443 -sTCP:LISTEN
lsof -nP -iTCP:5432 -sTCP:LISTEN
```

Missing route in `dev ls`:

- verify app exists in `.devrouter.yml`
- verify `dev app run <name>` was executed
- verify docker service started if runtime is docker

## 9) AI agent prompt (single copy-paste)

Use this as the only onboarding prompt for agents:

```bash
dev init --repo /absolute/path/to/repo
```

For tool/automation pipelines:

```bash
dev init --repo /absolute/path/to/repo --json
```

## 10) Definition of done

- `.devrouter.yml` exists and validates.
- `dev app ls` and `dev ls` are correct.
- Routes are stable via `.localhost` hostnames.
- Setup is reproducible by another engineer.
