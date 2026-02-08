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

Current dependency behavior:

- Docker dependencies can be auto-started.
- Host-runtime dependencies are not auto-started in v1 and must be started manually.

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

Legacy cutover errors:

- `dev add` and `dev host ...` are deprecated
- migrate to `dev repo init` + `dev app add` + `dev app run`

## 9) AI agent prompt (single copy-paste)

```text
You are adapting an existing repository to devrouter using the unified .devrouter.yml model.

Objective:
- Configure stable local hostnames (*.localhost) for app/database access through the shared devrouter.
- Avoid manual/random host ports for app access.
- Keep repo changes minimal, explicit, and reproducible.

How devrouter works (must respect):
- Shared Traefik router owns host ports 80 (HTTP), 443 (HTTPS), and 5432 (Postgres TCP).
- Per-repo source of truth is REPO_PATH/.devrouter.yml only.
- Global generated/runtime artifacts are managed under ~/.config/devrouter (do not edit these manually).
- Legacy files/commands are cut over (devrouter.host.yml, docker-compose.devrouter.yml, dev add, dev host ...).

Inputs:
- REPO_PATH=<REPO_PATH>
- ENTRIES_JSON=<JSON_ARRAY_OF_APP_ENTRIES>

Entry schema (each object):
- name: string (unique in repo)
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

Validation rules to enforce:
- host must end with .localhost
- runtime=host supports protocol=http only
- protocol=tcp requires runtime=docker and tcpProtocol=postgres
- unknown keys are not allowed (strict schema)
- do not introduce deprecated/legacy config files

Runtime behavior to account for:
- Docker dependencies can be auto-started by dev app run.
- Host-runtime dependencies are NOT auto-started in v1 (must be started manually).
- Postgres multiplexing on shared :5432 requires TLS/SNI.
- For TCP/Postgres, expect clients to use sslmode=require (or stricter).

Required workflow:
1) Inspect repository structure first (compose files, scripts, app folders, existing dev docs).
2) Create/update only REPO_PATH/.devrouter.yml.
3) Keep edits minimal and idempotent.
4) Do not modify unrelated files/services.
5) If required info is missing or ambiguous, stop and ask targeted questions.

Validation commands to run/report:
- dev app ls --repo <REPO_PATH>
- For each entry (when safe): dev app run <name> --repo <REPO_PATH> --yes
- dev ls
- For HTTP entries: curl -I http://<host>
- For TCP postgres entries: provide connection hint (example: psql "... sslmode=require")

Output format (strict):
1) Repository structure summary relevant to routing.
2) Proposed app mapping (name/host/protocol/runtime/deps) with assumptions.
3) Exact file changes made to .devrouter.yml.
4) Concise diff summary.
5) Validation commands run + key outputs.
6) Unresolved questions/risks (if any).
7) Definition-of-done checklist status:
   - .devrouter.yml exists and validates
   - dev app ls matches expected entries
   - dev ls exposes expected endpoints
   - HTTP routes reachable
   - TCP Postgres route configured with TLS requirement noted
```

## 10) Definition of done

- `.devrouter.yml` exists and validates.
- `dev app ls` and `dev ls` are correct.
- Routes are stable via `.localhost` hostnames.
- Setup is reproducible by another engineer.
