# devrouter

Local-first routing for macOS development with one shared Traefik router.

## What it solves

Run multiple repos concurrently without manual port juggling:

- HTTP apps by hostname: `web.localhost`, `api.localhost`
- PostgreSQL DBs by hostname on shared `:5432` via TLS/SNI: `db.localhost`

Traefik owns:

- `:80` (HTTP)
- `:443` (HTTPS)
- `:5432` (Postgres TCP routing)

## Unified repo config

Each repo now uses one file:

- `.devrouter.yml`

This is the only supported per-repo config for app routing/runtime definitions.

## Core commands

- `dev up`
- `dev down`
- `dev status [--json]`
- `dev ls [--json]`
- `dev open <name>`
- `dev tls install`
- `dev repo init [--repo <path>]`
- `dev app add ...`
- `dev app ls [--repo <path>] [--json]`
- `dev app run <name> [--repo <path>] [--yes]`
- `dev app rm <name> [--repo <path>]`

## `.devrouter.yml` example

```yaml
version: 1
project:
  name: my-repo
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: host
    hostRun:
      command: pnpm dev
      cwd: .
      strategy:
        type: auto
        denyPorts: [80, 443, 5432]
        allowPortRange: "1024-65535"
    dependencies:
      - app: db

  - name: db
    host: db.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: docker
    docker:
      service: db
      internalPort: 5432
      composeFiles:
        - docker-compose.yml
```

Notes:

- TCP mode currently supports PostgreSQL first (`tcpProtocol: postgres`).
- Multi-DB hostname routing on shared `:5432` requires TLS/SNI.
- Plaintext Postgres is not supported for multiplexed hostname routing.

## Runtime behavior

`dev app run <name>`:

- reads `.devrouter.yml`
- prompts to start declared dependencies (or use `--yes`)
- starts only declared docker dependency services
- fails fast if host-runtime dependencies are configured (start those manually)
- starts host app command for host runtime apps
- generates docker overlay in `~/.config/devrouter/cache/...` for docker runtime apps

## First onboarding quick path

In a repo that has a host app and a Docker Postgres service:

```bash
dev repo init
dev app add --name web --host web.localhost --protocol http --runtime host --command "pnpm dev" --cwd .
dev app add --name db --host db.localhost --protocol tcp --runtime docker --tcp-protocol postgres --service db --port 5432 --compose-file docker-compose.yml
dev app add --name web --host web.localhost --protocol http --runtime host --command "pnpm dev" --cwd . --depends-on db
dev tls install
dev app run web --yes
dev ls
```

Expected endpoints:

- `https://web.localhost`
- `postgres://db.localhost:5432 (tls required)`

## Demo workspace (in this repo)

A complete sample repository is included at:

- [`./demo`](./demo)

It contains:

- one app running on host (`web-host`)
- the same app running in Docker (`web-docker`)
- Postgres in Docker (`db`)
- ready-to-use `.devrouter.yml`

Run the end-to-end smoke demo:

```bash
pnpm demo:smoke
```

See details:

- [`./demo/README.md`](./demo/README.md)

## Known limitations (v1)

- Host-runtime dependencies are not auto-started; only Docker dependencies are auto-started.
- TCP routing currently supports PostgreSQL only (`tcpProtocol: postgres`).
- Shared `:5432` hostname multiplexing requires TLS/SNI (`sslmode=require` or stronger).

## Router state

Global managed artifacts remain under:

- `~/.config/devrouter/compose.yml`
- `~/.config/devrouter/traefik/traefik.yml`
- `~/.config/devrouter/traefik/dynamic/base.yml`
- `~/.config/devrouter/traefik/dynamic/host-routes.yml`
- `~/.config/devrouter/host-routes-state.json`
- `~/.config/devrouter/cache/...`
- `~/.config/devrouter/certs/*`

## Docs

- Setup and bootstrapping: [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)
- Onboarding repositories and AI prompt: [`docs/REPO_ONBOARDING.md`](./docs/REPO_ONBOARDING.md)
- Agent contributor guide: [`AGENTS.md`](./AGENTS.md)
- Demo workspace: [`./demo/README.md`](./demo/README.md)
- Roadmap: [`docs/PLAN.md`](./docs/PLAN.md)
