# REPO_ONBOARDING.md

Guide for adapting an existing repository to unified `devrouter` config.

## 1) Purpose

Onboard any repo using one config file:

- `.devrouter.yml`

Track the applied devrouter release for agent upgrades with:

- `devrouter.yaml` (`version: <semver>`, used by `dev -V` / `dev upgrade`)

Supported route types:

- HTTP host-run apps
- HTTP docker apps
- TCP PostgreSQL docker apps (TLS/SNI on shared `:5432`)
- Dependency-only docker services (`kind: dependency`, non-routed)

Scope:

- no Kubernetes
- no central service registry
- no random host-port URLs for app access

## 2) Before you start

Complete global setup first:

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)
- Release/adaptation history: [`../CHANGELOG.md`](../CHANGELOG.md)

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
- `kind` (`app` or `dependency`, default `app`)
- if `kind=app`: `host` (`*.localhost`, including multi-segment forms like `elearning.klicker.localhost`)
- if `kind=app`: `protocol` (`http` or `tcp`)
- `runtime` (`host` or `docker`; for `kind=dependency` must be `docker`)

Host runtime (`http` only):

- `command`
- `cwd`
- `portTimeout` (optional, seconds, default 120)
- optional dependencies

Note: `dev app run` injects `PORT=<free-port>` into the host app environment.
Frameworks reading `PORT` (Next.js, Vite, Remix, etc.) bind to this port automatically.
Prefer an existing repo dev script (`pnpm dev`, `npm run dev`, etc.) instead of handcrafted command chains.
For Next.js apps behind proxied/custom `.localhost` dev hosts, align dev-origin host settings in `next.config.*` for your installed Next.js version (option names changed across releases).

Docker runtime:

- `service`
- `composeFiles`
- optional dependencies
- for routed docker apps: `internalPort`
- for routed TCP apps: `tcpProtocol=postgres`
- for `kind=dependency`: no routed fields (`host`, `protocol`, `tcpProtocol`, `hostRun`, `docker.internalPort`, `docker.router`)

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

Set upgrade metadata for this repo:

```yaml
# devrouter.yaml
version: <semver>
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

Add dependency-only Redis service:

```bash
dev app add \
  --name redis \
  --kind dependency \
  --service redis \
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
  --depends-on db \
  --depends-on redis

dev up
dev tls install
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
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL
```

Current dependency behavior:

- Docker dependencies can be auto-started.
- Host-runtime dependencies are not auto-started in v1 and must be started manually.
- `kind=dependency` apps are dependency-only and cannot be direct `dev app run`, `dev app exec`, or `dev open` targets.
- `kind=dependency` services start as defined in compose (no Traefik label wiring, no injected env vars, no random published ports).
- `dev app exec` starts deps as needed and runs a single command with resolved env.
- `dev app exec` stops only deps started by that exec call; already-running deps stay running.
- If `dev app exec` cannot determine pre-existing running services, it leaves selected deps running to avoid non-owned teardown.
- With TLS enabled, `dev app run` / `dev app exec` auto-refresh cert SAN coverage for configured repo hosts before startup.
- Default exec mode is argv-safe (`shell: false`) to avoid nested quoting issues.
- Use `--shell` only when shell expansion is required; it accepts exactly one command string after `--`.
- Use repeatable `--env-map TARGET=SOURCE` to alias env vars for non-Prisma frameworks (for example `DATABASE_URI=DATABASE_URL`).

Secret manager interop (Infisical/Doppler):

- devrouter injected vars for postgres deps: `DB_HOST`, `DB_PORT`, `DATABASE_URL`, `SHADOW_DATABASE_URL`.
- If your secret manager also provides DB vars, do not assume precedence.
- Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values.
- Safe host-run override pattern when wrapper also defines `DATABASE_URI`:
  `infisical run --projectId <id> --env=<env> -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} pnpm dev`
- Probe effective env before migration/seed:

```bash
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL
```

- `dev doctor --repo <path>` warns on risky pre-wrapper DB assignments for host apps with postgres dependencies (`repo.host-command-env-precedence`).
- With TLS enabled, `dev doctor --repo <path>` warns on cert SAN mismatches for configured hosts (`repo.tls-host-coverage`).

Compatibility note: older versions flattened `dev app exec` commands into a shell string; prefer argv-safe form on `v0.0.7+`.

## 5) What changes

Repo file:

- `.devrouter.yml` is updated/maintained.

Global generated state:

- `~/.config/devrouter/cache/.../compose.devrouter.yml`
- `~/.config/devrouter/traefik/dynamic/host-routes.yml`
- `~/.config/devrouter/host-routes-state.json`

No repo-local compose overlay file is required anymore.

## 6) Validation checklist

- `dev -V` shows installed CLI version, local repo version, and next upgrade target.
- `dev upgrade` lists upgrade targets and marks the next one.
- `dev upgrade <version>` prints that target adaptation prompt and reports further versions.
- `dev app ls` shows expected entries.
- `dev ls` shows both HTTP and/or TCP endpoints, including app and service identity columns.
- `kind=dependency` entries appear in `dev app ls` but do not create active endpoints in `dev ls`.
- `dev doctor --repo <path>` reports no blocking errors.
- `dev doctor --repo <path>` does not warn on `repo.tls-host-coverage`.
- HTTP app reachable at `https://<host>.localhost` (after `dev tls install`).
- Postgres route visible as `postgres://<host>.localhost:5432 (tls required)`.
- No duplicate hostnames.

## 7) TLS requirements for Postgres TCP

Postgres hostname multiplexing on one shared `:5432` requires TLS/SNI.
`*.localhost` covers single-label hosts (for example `web.localhost`), while multi-segment hosts
(for example `elearning.klicker.localhost`) require exact SAN entries. devrouter auto-refreshes
those SANs on `dev app run` / `dev app exec` when TLS is enabled.

Run:

```bash
dev tls install
```

Client connections should use TLS (for example `sslmode=require`).
For validation and quick connection hints, use `dev open <name>` (`<name>` resolves app name first, then service/container/host).

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

Browser shows `TRAEFIK DEFAULT CERT` for a `.localhost` host:

- run `dev app run <name> --repo <path> --yes` to trigger SAN auto-refresh
- or run `dev tls install` to refresh certificates manually

Docker errors with `no space left on device`:

- free Docker disk space using your preferred method
- retry the failed command (`dev up`, `dev app run`, or `dev app exec`)

Postgres auth or database mismatch after credential changes:

- existing persistent volumes may still contain old credentials/default DB state
- reconcile credentials/data or recreate volumes when safe (for example `docker compose down -v`)

## 9) AI agent discoverability

Write a devrouter section into the repo's `AGENTS.md` and install a skill file:

```bash
dev repo agents
```

This creates/updates:

- `AGENTS.md` -- short devrouter section pointing to the skill file
- `.factory/skills/devrouter/SKILL.md` -- full reference (config schema, docker requirements, env injection, commands)

The skill content is embedded in the CLI bundle, so `dev repo agents` always writes the version matching the installed CLI.

Optional Linear workflow bootstrap:

```bash
dev repo agents --with-linear
```

This additionally creates:

- `AGENTS.md` linear-workflow section
- `.factory/skills/linear-workflow/SKILL.md`
- `.factory/skills/linear-workflow/references/LINEAR_ISSUE_TEMPLATE.md`
- `.factory/skills/linear-workflow/references/MILESTONE_PLAN_TEMPLATE.md`
- `.factory/skills/linear-workflow/references/PROGRESS_UPDATE_TEMPLATE.md`
- `AGENTS.md` managed Linear mapping block (`workspace/team/project`) between:
  - `<!-- devrouter-linear-workflow-config:start -->`
  - `<!-- devrouter-linear-workflow-config:end -->`

Interactive runs prompt for workspace/team/project values. Non-interactive runs write placeholders and warn.

Required Linear execution hygiene:

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

## 10) AI agent prompt (single copy-paste)

Use this as the only onboarding prompt for agents:

```bash
dev init --repo /absolute/path/to/repo
```

For tool/automation pipelines:

```bash
dev init --repo /absolute/path/to/repo --json
```

Optional explicit artifact writes:

```bash
dev init --repo /absolute/path/to/repo --write-agents --write-skill
```

Optional Linear workflow guidance + artifacts:

```bash
dev init --repo /absolute/path/to/repo --with-linear --write-agents --write-skill
```

With `--with-linear` + AGENTS writes, devrouter asks for:

- workspace name
- team name (optional team key)
- project name (optional project id)

## 11) Definition of done

- `.devrouter.yml` exists and validates.
- `dev app ls` and `dev ls` are correct.
- Routes are stable via `.localhost` hostnames.
- Setup is reproducible by another engineer.
