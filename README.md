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

Legacy commands (`dev add`, `dev host ...`) are hard-cutovered and return migration guidance.

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
- starts host app command for host runtime apps
- generates docker overlay in `~/.config/devrouter/cache/...` for docker runtime apps

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

- Setup and bootstrapping: [`GETTING_STARTED.md`](./GETTING_STARTED.md)
- Onboarding repositories and AI prompt: [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)
- Agent contributor guide: [`AGENTS.md`](./AGENTS.md)
- Roadmap: [`PLAN.md`](./PLAN.md)
