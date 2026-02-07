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

## 3) Required per-repo decisions

For each app entry decide:

- `name`
- `host` (`*.localhost`)
- `protocol` (`http` or `tcp`)
- `runtime` (`host` or `docker`)

Host runtime (`http` only):

- `command`
- `cwd`
- optional dependencies

Docker runtime:

- `service`
- `internalPort`
- `composeFiles`
- optional dependencies
- for TCP, `tcpProtocol=postgres`

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

Legacy cutover errors:

- `dev add` and `dev host ...` are deprecated
- migrate to `dev repo init` + `dev app add` + `dev app run`

## 9) AI agent prompt (single copy-paste)

```text
You are adapting an existing repository to use unified devrouter config (.devrouter.yml).

Inputs:
- REPO_PATH=<REPO_PATH>
- ENTRIES_JSON=<JSON_ARRAY_OF_APP_ENTRIES>

Entry schema (each object):
- name: string
- host: <name>.localhost
- protocol: "http" | "tcp"
- runtime: "host" | "docker"
- dependencies: [{ app: "<name>" }] (optional)
- if runtime=host:
  - hostRun.command: string
  - hostRun.cwd: string
  - hostRun.strategy.type: "auto"
  - hostRun.strategy.denyPorts: [80, 443, 5432]
  - hostRun.strategy.allowPortRange: "1024-65535"
- if runtime=docker:
  - docker.service: string
  - docker.internalPort: number
  - docker.composeFiles: string[]
  - optional docker.router: string
- if protocol=tcp:
  - tcpProtocol: "postgres"

Requirements:
1) Inspect repository structure first (compose files, package scripts, app folders).
2) Create/update REPO_PATH/.devrouter.yml only.
3) Keep changes minimal and idempotent.
4) Do not modify unrelated services/files.
5) For protocol=tcp, enforce tcpProtocol=postgres and runtime=docker.
6) If ambiguous inputs are discovered, stop and ask targeted questions.

Validation commands to run/report:
- dev app ls --repo <REPO_PATH>
- for each entry:
  - dev app run <name> --repo <REPO_PATH> --yes (when safe for local run)
- dev ls
- for HTTP entries: curl -I http://<host>

Output format:
1) Summary of detected project structure.
2) Exact file changes.
3) Concise diff summary.
4) Validation command outputs (key excerpts).
5) Follow-up actions required.
```

## 10) Definition of done

- `.devrouter.yml` exists and validates.
- `dev app ls` and `dev ls` are correct.
- Routes are stable via `.localhost` hostnames.
- Setup is reproducible by another engineer.
