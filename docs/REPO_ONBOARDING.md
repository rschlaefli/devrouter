# REPO_ONBOARDING.md

Guide for adapting an existing repository to unified `devrouter` config.

## 1) Purpose

Onboard any repo using one config file:

- `.devrouter.yml`

Track the applied devrouter release for agent upgrades with:

- `.devrouter.yml` metadata (`devrouter.version`, used by `devrouter -V` / `devrouter upgrade`)

Supported route types:

- HTTP host-run apps
- HTTP docker apps
- HTTP proxy apps (`runtime: proxy`, route to an already-running `upstream`; supports `${WORKSPACE}` placeholder for parallel-worktree isolation)
- TCP apps with TLS/SNI (`runtime: docker` or `runtime: proxy`; supported `tcpProtocol`: `postgres`, `redis`, `mariadb`, `mysql`)
- Dependency-only docker services (`kind: dependency`, non-routed)
- Parallel git worktrees via `devrouter workspace up/ensure/ls/down` with persisted identities and proven, auto-namespaced `.localhost` routes

Scope:

- no Kubernetes
- no central service registry
- no random host-port URLs for app access

## 2) Before you start

Complete global setup first:

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)
- Release/adaptation history: [`../CHANGELOG.md`](../CHANGELOG.md) and [`../upgrade-prompts/`](../upgrade-prompts/)

Assumptions:

- `dev` CLI is installed
- `devrouter setup --yes` has completed or `devrouter doctor --json` explains what is missing
- macOS local environment

Agent-native first pass:

```bash
devrouter setup --yes --json
devrouter doctor --json
devrouter repo inspect --repo /absolute/path/to/repo --json
devrouter repo devcontainer write --repo /absolute/path/to/repo --dry-run --json
devrouter repo devcontainer write --repo /absolute/path/to/repo --yes
devrouter repo devcontainer verify --repo /absolute/path/to/repo --json
```

`devrouter repo inspect` is read-only. It reports package manager metadata, scripts and likely ports, compose services, env variable names (not values), existing `.devcontainer/`, `.devrouter.yml`, and agent guidance files. Use its evidence and issues to write a small onboarding plan before editing files.

`devrouter repo devcontainer write --dry-run --json` plans the managed files. `devrouter repo devcontainer write --yes` writes only when target files are missing or already marked as devrouter-managed; custom existing `.devcontainer/` or `.devrouter.yml` files stop the write with a conflict. The first scaffold supports Node + pnpm + Postgres; non-pnpm repos stop with `repo.devcontainer.package-manager-unsupported`.

`devrouter repo devcontainer verify --json` is read-only and produces PR evidence from doctor checks, required files, proxy app entries, and workspace namespacing. Use `--live --yes --json` only after the devcontainer is running and you want route registration plus HTTP probes.

PR evidence checklist for agents:

- setup and doctor summaries
- inspect facts and issues
- static verify summary
- live verify summary when DevPod was run locally
- tested URLs, TCP route status, and skipped live checks with reasons

Reference implementation:

- [`../examples/devcontainer/README.md`](../examples/devcontainer/README.md) shows the agent-native DevPod/devcontainer flow with static/live verify evidence.
- [`../examples/routing/README.md`](../examples/routing/README.md) shows a complete setup with:
  - host app route
  - docker app route
  - postgres tcp route

## 3) Required per-repo decisions

For each app entry decide:

- `name`
- `kind` (`app` or `dependency`, default `app`)
- if `kind=app`: `host` (`*.localhost`, including multi-segment forms like `elearning.klicker.localhost`)
- if `kind=app`: `protocol` (`http` or `tcp`)
- `runtime` (`host` or `docker`; for `kind=dependency` must be `docker`)

Host runtime (`http` only):

- `command`
- `cwd`
- `portTimeout` (optional, seconds, default 120)
- optional dependencies

Note: `devrouter app run` injects `PORT=<free-port>` into the host app environment.
Frameworks reading `PORT` (Next.js, Vite, Remix, etc.) bind to this port automatically.
Prefer an existing repo dev script (`pnpm dev`, `npm run dev`, etc.) instead of handcrafted command chains.
For Next.js apps behind proxied/custom `.localhost` dev hosts, align dev-origin host settings in `next.config.*` for your installed Next.js version (option names changed across releases).

Docker runtime:

- `service`
- `composeFiles`
- optional dependencies
- for routed docker apps: `internalPort`
- for routed TCP apps: set `tcpProtocol` to one supported protocol (`postgres`, `redis`, `mariadb`, or `mysql`)
- for `kind=dependency`: no routed fields (`host`, `protocol`, `tcpProtocol`, `hostRun`, `docker.internalPort`, `docker.router`)

Docker compose file guidance:

- Every dependency service **must** define a `healthcheck` (devrouter uses `--wait` to block until healthy)
- Services **must not** publish host ports for devrouter-owned ports (80, 443, 5432)
- Services **should not** publish host ports at all; use devrouter hostnames instead
- `devrouter app run` waits for deps to become healthy, auto-stops docker deps when a host app exits, leaves docker app targets running until explicit cleanup, and prints recent dep logs

## 4) Fast path

Initialize:

```bash
devrouter repo init
```

`devrouter repo init` writes `.devrouter.yml` with schema `version: 1` and initializes upgrade metadata at `devrouter.version` to the installed CLI version.
If you need to align metadata manually, use:

```yaml
version: 1
devrouter:
  version: <semver>
apps: []
```

Add host app:

```bash
devrouter app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd .
```

Add docker Postgres:

```bash
devrouter app add \
  --name db \
  --host db.localhost \
  --protocol tcp \
  --runtime docker \
  --tcp-protocol postgres \
  --service db \
  --port 5432 \
  --compose-file docker-compose.yml
```

Add dependency-only Redis service:

```bash
devrouter app add \
  --name redis \
  --kind dependency \
  --service redis \
  --compose-file docker-compose.yml
```

Link dependency and run:

```bash
devrouter app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd . \
  --depends-on db \
  --depends-on redis

devrouter setup --yes
devrouter app run web
```

Use `--yes` for non-interactive runs:

```bash
devrouter app run web --yes
```

Run one-shot commands (migrations, seeds) with resolved dep env vars:

```bash
devrouter app exec web --yes -- npx prisma migrate dev
devrouter app exec web --yes -- npx prisma db seed
devrouter app exec web --yes -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate
devrouter app exec web --yes -- printenv DB_URL DATABASE_URL DB_HOST DB_PORT DB_SHADOW_URL SHADOW_DATABASE_URL
```

Current dependency behavior:

- Docker dependencies can be auto-started.
- Host-runtime dependencies are not auto-started in v1 and must be started manually.
- `kind=dependency` apps are dependency-only and cannot be direct `devrouter app run`, `devrouter app exec`, or `devrouter open` targets.
- `kind=dependency` services start as defined in compose (no Traefik label wiring, no injected env vars, no random published ports).
- `devrouter app exec` starts deps as needed and runs a single command with resolved env.
- `devrouter app exec` stops only deps started by that exec call; already-running deps stay running.
- If `devrouter app exec` cannot determine pre-existing running services, it leaves selected deps running to avoid non-owned teardown.
- With TLS enabled, `devrouter app run` / `devrouter app exec` auto-refresh cert SAN coverage for configured repo hosts before startup.
- Default exec mode is argv-safe (`shell: false`) to avoid nested quoting issues.
- Use `--shell` only when shell expansion is required; it accepts exactly one command string after `--`.
- Use config-level `envMap` on dependency references to alias env vars for app-specific names:
  ```yaml
  dependencies:
    - app: db
      envMap:
        DATABASE_URL: DB_URL
        DIRECT_URL: DB_URL
        SHADOW_DATABASE_URL: DB_SHADOW_URL
  ```

Secret manager interop (Infisical/Doppler):

- devrouter injected vars for postgres deps: `DB_HOST`, `DB_PORT`, `DB_URL`, `DB_SHADOW_URL`; configured `envMap` aliases may also expose app-specific names such as `DATABASE_URL`.
- If your secret manager also provides DB vars, do not assume precedence.
- Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values.
- Safe host-run override pattern when wrapper also defines `DATABASE_URI`:
  `infisical run --projectId <id> --env=<env> -- env DATABASE_URI=${DB_URL:?missing DB_URL} pnpm dev`
- Probe effective env before migration/seed:

```bash
devrouter app exec web --yes -- printenv DB_URL DATABASE_URL DB_HOST DB_PORT DB_SHADOW_URL SHADOW_DATABASE_URL
```

- `devrouter doctor --repo <path>` warns on risky pre-wrapper DB assignments for host apps with postgres dependencies (`repo.host-command-env-precedence`).
- With TLS enabled, `devrouter doctor --repo <path>` warns on cert SAN mismatches for configured hosts (`repo.tls-host-coverage`).

## 5) What changes

Repo file:

- `.devrouter.yml` is updated/maintained.
- `.devcontainer/docker-compose.devrouter.yml` is the committed linked-worktree overlay; `workspace ensure` supplies its Git common-directory bind source.

Global generated state:

- `~/.config/devrouter/cache/.../compose.devrouter.yml`
- `~/.config/devrouter/traefik/dynamic/host-routes.yml`
- `~/.config/devrouter/host-routes-state.json`

Runtime-generated app overlays stay under the global cache. The committed devcontainer overlay has a different job: it preserves linked-worktree Git metadata and is selected only for the workspace lifecycle.

## 6) Validation checklist

- `devrouter -V` shows installed CLI version, local repo version, and next upgrade target.
- `devrouter upgrade` lists upgrade targets and marks the next one.
- `devrouter upgrade <version>` prints that target adaptation prompt and reports further versions.
- `devrouter upgrade` reads versioned prompt files from `upgrade-prompts/<version>.md`.
- `devrouter app ls` shows expected entries.
- `devrouter ls` shows both HTTP and/or TCP endpoints, including app and service identity columns.
- `kind=dependency` entries appear in `devrouter app ls` but do not create active endpoints in `devrouter ls`.
- `devrouter doctor --repo <path>` reports no blocking errors.
- `devrouter doctor --repo <path>` does not warn on `repo.tls-host-coverage`.
- HTTP app reachable at `https://<host>.localhost` (after `devrouter tls install`).
- Postgres route visible as `postgres://<host>.localhost:5432 (tls required)`.
- No duplicate hostnames.

## 7) TLS requirements for Postgres TCP

Postgres hostname multiplexing on one shared `:5432` requires TLS/SNI.
`*.localhost` covers single-label hosts (for example `web.localhost`), while multi-segment hosts
(for example `elearning.klicker.localhost`) require exact SAN entries. devrouter auto-refreshes
those SANs on `devrouter app run` / `devrouter app exec` when TLS is enabled.

Run:

```bash
devrouter tls install
```

Client connections should use TLS (for example `sslmode=require`).
For validation and quick connection hints, use `devrouter open <name>` (`<name>` resolves app name first, then service/container/host).

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

Missing route in `devrouter ls`:

- verify app exists in `.devrouter.yml`
- verify `devrouter app run <name>` was executed
- verify docker service started if runtime is docker

Browser shows `TRAEFIK DEFAULT CERT` for a `.localhost` host:

- run `devrouter app run <name> --repo <path> --yes` to trigger SAN auto-refresh
- or run `devrouter tls install` to refresh certificates manually

Docker errors with `no space left on device`:

- free Docker disk space using your preferred method
- retry the failed command (`devrouter up`, `devrouter app run`, or `devrouter app exec`)

Postgres auth or database mismatch after credential changes:

- existing persistent volumes may still contain old credentials/default DB state
- reconcile credentials/data or recreate volumes when safe (for example `docker compose down -v`)

## 9) AI agent discoverability

Write a devrouter section into the repo's `AGENTS.md` and install a skill file:

```bash
devrouter repo agents
```

This creates/updates:

- `AGENTS.md` -- short devrouter section pointing to the skill file
- `.agents/skills/devrouter/SKILL.md` -- full reference (config schema, docker requirements, env injection, commands)

The skill content is embedded in the CLI bundle, so `devrouter repo agents` always writes the version matching the installed CLI.



## 10) Workspace isolation (parallel worktrees)

Multiple git worktrees of the same repo can run concurrently using a persisted **workspace token**. First use reuses an exact-path DevPod or derives a sanitized branch/path slug; after that the Git-metadata identity is authoritative. The primary checkout stays plain and non-namespaced.

**Proxy upstream placeholder:** use `${WORKSPACE}` in the `upstream` field of a `runtime: proxy` app so devrouter substitutes the active token at runtime. Using `${WORKSPACE}` in `host` is rejected — hosts are auto-namespaced automatically.

```yaml
- name: app
  host: app.localhost        # → app.<ws>.localhost when workspace is active
  protocol: http
  runtime: proxy
  upstream: ${WORKSPACE}-app:3000   # → feat-a-app:3000 for workspace feat-a
```

**Lifecycle:**

```bash
# Create worktree, start devpod, register routes
devrouter workspace up feat/my-feature

# Reconcile an existing linked worktree and prove it is ready
devrouter workspace ensure .

# List worktrees with workspace tokens and route counts
devrouter workspace ls

# Free routes, stop devpod, remove worktree
devrouter workspace down feat/my-feature
```

`devrouter doctor` check `routes.orphaned-workspace-routes` reports routes whose worktree was removed without `devrouter workspace down`; it does not mutate route state.

Workspace-aware devcontainers must select `.devcontainer/docker-compose.devrouter.yml` via `DEVCONTAINER_COMPOSE_OVERLAY`. The overlay passes `WORKSPACE` and `DEVROUTER_WORKSPACE` into the app and bind-mounts `${DEVROUTER_GIT_COMMON_DIR}` to the same absolute path. `workspace ensure` verifies that contract plus the exact worktree, aliases, health, Git access, route ownership, and reachability before success.

## 11) AI agent prompt (single copy-paste)

Use this as the only onboarding prompt for agents:

```bash
devrouter init --repo /absolute/path/to/repo
```

For tool/automation pipelines:

```bash
devrouter init --repo /absolute/path/to/repo --json
```

Optional explicit artifact writes:

```bash
devrouter init --repo /absolute/path/to/repo --write-agents --write-skill
```



## 12) Definition of done

- `.devrouter.yml` exists and validates.
- `devrouter app ls` and `devrouter ls` are correct.
- Routes are stable via `.localhost` hostnames.
- Setup is reproducible by another engineer.
