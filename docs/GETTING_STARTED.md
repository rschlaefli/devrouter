# GETTING_STARTED.md

Setup and first-run guide for `devrouter` using the unified `.devrouter.yml` model.

## 1) Prerequisites

- macOS
- Docker daemon + CLI
- Node `>=24`
- pnpm
- pre-commit (for repository Git hooks)
- mkcert (recommended for local HTTPS/TCP routing)
- Homebrew (optional, convenient for installing mkcert/DevPod)

Quick checks:

```bash
docker --version
docker context show
node -v
pnpm -v
```

`devrouter setup --yes --json` also checks Docker Compose v2, mkcert, DevPod, and the repo's Node/pnpm toolchain, then reports exact remediation steps for missing tools.

## 2) Install CLI locally

From the repo root:

```bash
pnpm bootstrap
```

This runs `pnpm install`, builds, and installs `~/.local/bin/dev`.

If needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```bash
dev --help
```

## Local quality checks

```sh
pre-commit install
```

Installs the git hooks defined in `.pre-commit-config.yaml`. Run once after cloning; hooks fire on every commit from that point forward.

```sh
pnpm check
```

Runs Biome in check mode across the repository: linting and formatting violations are reported but nothing is written. Use this in CI or to inspect the current state without touching files.

```sh
pnpm check:fix
```

Applies Biome fixes in place – formatting and auto-fixable lint rules. Handles import ordering as part of the same pass.

```sh
pnpm knip
```

Finds unused files, unused dependencies, unlisted dependencies, and unresolved imports. The output is current state; nothing is removed automatically.

```sh
pnpm typecheck
```

Runs the TypeScript compiler in no-emit mode. Covers the full project graph.

Version and upgrade quick check (against the bundled routing example metadata):

```bash
devrouter -V --repo ./examples/routing
```

Optional: run the bundled routing smoke (host app + Docker app + Postgres):

```bash
pnpm routing:smoke
```

Sample assets live in:

- [`../examples/routing/README.md`](../examples/routing/README.md)
- [`../examples/devcontainer/README.md`](../examples/devcontainer/README.md)

For the live DevPod/devcontainer showcase:

```bash
pnpm devcontainer:smoke
pnpm devcontainer:smoke down
```

Release and adaptation notes live in [`../CHANGELOG.md`](../CHANGELOG.md), with prompt files in [`../upgrade-prompts/`](../upgrade-prompts/).

## Docker compose requirements for devrouter

### Healthcheck required

Every Docker service used as a dependency **must** define a `healthcheck`. devrouter uses `docker compose up --wait`, which blocks until services report healthy. Without a healthcheck, the wait returns immediately and the dependent app may start before the service is ready.

Example for Postgres:

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U app -d app"]
  interval: 5s
  timeout: 3s
  retries: 20
```

### No published host ports

Services **must not** publish host ports (`ports:` mapping) for ports owned by devrouter (80, 443, 5432). Traefik owns these; conflicts cause bind failures.

Services **should not** publish host ports at all. devrouter handles external routing via Traefik labels. Publishing ports creates conflicts when running multiple repos. Use devrouter hostnames (e.g. `routing-db.localhost:5432`) instead of `localhost:<mapped-port>`.

### Dependency lifecycle

- `devrouter app run` waits for Docker dependencies to become healthy before starting the host or docker app
- Docker dependencies are automatically stopped when a host app exits (Ctrl+C or error); docker app services remain running until explicit cleanup (`docker compose down`, `devrouter down`, or equivalent)
- Recent dependency logs (last 20 lines) are printed after dependencies start
- `kind=dependency` entries are dependency-only: they do not create routes and cannot be direct targets for `devrouter app run`, `devrouter app exec`, or `devrouter open`
- `kind=dependency` services are started as declared in compose (no Traefik labels, no random port publishing, no injected env vars)

### TCP dependency env injection

When a host app depends on a TCP Docker service, `devrouter app run` automatically:

1. Publishes the service's internal port on a random host port
2. Queries the mapped port after startup
3. Injects per-dep env vars based on `{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")`

All TCP deps get `{PREFIX}_HOST` and `{PREFIX}_PORT`. Protocol-specific URL vars:

| Protocol | `{PREFIX}_URL` | `{PREFIX}_SHADOW_URL` |
|----------|----------------|----------------------|
| postgres | `postgres://prisma:prisma@localhost:{PORT}/prisma` | `postgres://prisma:prisma@localhost:{PORT}/shadow` |
| redis | `redis://localhost:{PORT}` | - |
| mysql/mariadb | `mysql://root@localhost:{PORT}` | - |

For example, a postgres dependency named `db` produces:

- `DB_HOST=localhost`
- `DB_PORT=54321`
- `DB_URL=postgres://prisma:prisma@localhost:54321/prisma`
- `DB_SHADOW_URL=postgres://prisma:prisma@localhost:54321/shadow`

Multiple TCP deps get unique vars without collision.

To alias per-dep vars to project-specific names, use `envMap` on the dependency reference:

```yaml
dependencies:
  - app: db
    envMap:
      DATABASE_URL: DB_URL
      DIRECT_URL: DB_URL
      SHADOW_DATABASE_URL: DB_SHADOW_URL
```

`envMap` entries are `TARGET: SOURCE` where SOURCE must exist in the resolved dep env. Aliases are applied before SM re-injection and flow through all downstream env resolution automatically.

### Running one-shot commands with dependency env vars

`devrouter app exec` starts dependencies as needed, resolves env vars, and runs a single command. It stops only dependencies started by that `exec` invocation; dependencies already running before `exec` stay running. Use it for migrations, seeding, or any CLI tool that needs the resolved env:

```bash
devrouter app exec web --yes -- npx prisma migrate dev
devrouter app exec web --yes -- npx prisma db seed
devrouter app exec web --yes -- printenv DB_URL DB_SHADOW_URL DB_HOST DB_PORT
```

The command receives the same per-dep env vars as `devrouter app run` (`{PREFIX}_HOST`, `{PREFIX}_PORT`, `{PREFIX}_URL`, etc.) plus any `envMap` aliases defined in config.
By default, exec preserves argv semantics (`shell: false`) so nested commands like `infisical run -- ...` stay stable without wrapper recursion.
If exec cannot determine which services were already running before startup, it leaves selected deps running to avoid stopping non-owned services.

Use `--shell` only when shell expansion is required, and pass exactly one command string after `--`:

```bash
devrouter app exec web --yes --shell -- "echo $DB_URL"
```

### Secret manager integration (config-based)

When a secret manager (Infisical, Doppler, etc.) wraps your dev commands, it can override devrouter-injected per-dep vars (`DB_URL`, `DB_SHADOW_URL`, etc.) and any `envMap` aliases you expose (`DATABASE_URL`, `DIRECT_URL`, etc.) with empty or different values. Add `secretManager` to `.devrouter.yml` so devrouter automatically re-applies its injected vars after the SM boundary:

```yaml
secretManager:
  command: infisical run --env dev --
```

For multi-environment setups, use the `{env}` template placeholder with `defaultEnv`:

```yaml
secretManager:
  command: infisical run --env {env} --
  defaultEnv: dev
```

Override at runtime with `--env`:

```bash
devrouter app exec web --yes --env stg -- pnpm prisma migrate deploy
devrouter app run web --env stg
```

When configured, `devrouter app run` and `devrouter app exec` wrap the user's command:

```
<secretManager.command> env DB_URL=<val> DB_SHADOW_URL=<val> ... <user-command>
```

The `env KEY=VAL` prefix is inserted between the SM boundary and the user command, re-applying all devrouter-injected dependency env vars (including `envMap` aliases) so they take precedence over whatever the SM set.

The SM command string must include the trailing `--` boundary (user responsibility).

### Secret manager interop (manual)

- devrouter injects per-dep vars (`{PREFIX}_HOST`, `{PREFIX}_PORT`, `{PREFIX}_URL`, `{PREFIX}_SHADOW_URL`) when a host app depends on TCP services.
- Use `envMap` in `.devrouter.yml` to alias per-dep vars to project-specific names (e.g. `DATABASE_URL: DB_URL`).
- If your secret manager also defines DB variables, do not assume precedence. Validate effective env before migration/seed.
- Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values.
- Recommended probe:

```bash
devrouter app exec web --yes -- printenv DB_URL DB_SHADOW_URL DB_HOST DB_PORT
```

- `devrouter doctor --repo <path>` warns on risky pre-wrapper DB assignments for host apps with postgres dependencies (`repo.host-command-env-precedence`).
- With TLS enabled, `devrouter doctor --repo <path>` also warns on cert SAN mismatches for configured hosts (`repo.tls-host-coverage`).

The TLS/SNI route on `:5432` remains available for tools that support `sslnegotiation=direct` (psql 17+, pgAdmin).

## 3) Localhost resolution notes

- Modern browsers resolve `*.localhost` to loopback.
- `/etc/hosts` does not support wildcard records.
- This tool does not mutate system DNS files in MVP.
- Multi-segment `.localhost` hosts are supported (for example `elearning.klicker.localhost`), and cert SANs are refreshed on `devrouter app run` / `devrouter app exec` when TLS is enabled.

Fallback for specific hostnames only:

```text
127.0.0.1 app.localhost
127.0.0.1 db.localhost
```

## 4) First-time machine setup

```bash
devrouter setup --yes
devrouter doctor --json
```

`devrouter setup` prepares devrouter-owned state: global router files, the shared `devnet` network, the Traefik router stack, and TLS certificates when `mkcert` is available. It does not install broad external toolchains; missing Docker/Compose, mkcert, DevPod, Node, or pnpm become remediation items.

`devrouter doctor` is check-only. Use it after setup fails, before opening a PR, or when diagnosing a machine/repo.

Lower-level commands remain available:

```bash
devrouter up
devrouter tls install
devrouter status
```

Expected bound ports:

- `80`
- `443`
- `5432`

If startup fails due conflicts:

```bash
lsof -nP -iTCP:80 -sTCP:LISTEN
lsof -nP -iTCP:443 -sTCP:LISTEN
lsof -nP -iTCP:5432 -sTCP:LISTEN
```

## 5) Initialize a repository

In the target repo:

```bash
devrouter repo init
```

This creates:

- `.devrouter.yml`
- includes `devrouter.version` initialized to the installed CLI version.

For upgrade-aware agent workflows, keep `.devrouter.yml` metadata (`devrouter.version`) aligned with the applied devrouter release:

```yaml
version: 1
devrouter:
  version: <semver>
apps: []
```

Then:

- `devrouter -V` shows installed CLI version, local repo version, and next upgrade target.
- `devrouter upgrade` lists available upgrade targets and marks the next one.
- `devrouter upgrade <version>` prints that target version's Agent Adaptation Prompt and indicates if a newer target is still available.
- `devrouter upgrade` reads prompt files from `upgrade-prompts/<version>.md`.

To write a devrouter section into the repo's `AGENTS.md` and install the devrouter skill:

```bash
devrouter repo agents
```

This creates:

- `AGENTS.md` section referencing devrouter (idempotent — skips if present)
- `.agents/skills/devrouter/SKILL.md` (always overwritten with latest content)

The skill file contains full config schema, docker requirements, env injection behavior, and command reference.



## 6) Generate onboarding prompt for an AI agent (optional)

From the target repository:

```bash
devrouter init
```

Or from elsewhere:

```bash
devrouter init --repo /absolute/path/to/repo
```

This prints the canonical onboarding prompt with the repository path injected.

`devrouter init` is non-mutating by default. To also write artifacts in one command, pass explicit flags:

```bash
devrouter init --repo /absolute/path/to/repo --write-agents --write-skill
```



## 7) Add apps to `.devrouter.yml`

HTTP host-run app:

```bash
devrouter app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd .
```

PostgreSQL docker app:

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

Proxy app (route to an already-running port, e.g. a devcontainer):

```bash
devrouter app add \
  --name app \
  --host app.localhost \
  --protocol http \
  --runtime proxy \
  --upstream 127.0.0.1:3000
```

devrouter registers the route only — no process is started and there are no
dependencies. Loopback upstreams are rewritten to `host.docker.internal` so
Traefik (in Docker) reaches the host. The route persists until `devrouter app rm`.

For parallel worktree setups, use `${WORKSPACE}` in the upstream instead of a
fixed address (e.g. `--upstream '${WORKSPACE}-app:3000'`). See section 15 for the
full workspace workflow.

Dependency-only docker service (Redis example):

```bash
devrouter app add \
  --name redis \
  --kind dependency \
  --service redis \
  --compose-file docker-compose.yml
```

Optional dependency link:

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
```

## Host app runtime behavior

**PORT injection**: `devrouter app run` automatically injects a `PORT` environment variable
with a random free port when starting host apps. Frameworks that read `PORT` (Next.js,
Vite, Remix, Fastify, etc.) will bind to this port instead of their default, avoiding
conflicts when running multiple apps.

**Bind address injection**: devrouter also sets `HOSTNAME=0.0.0.0` and `HOST=0.0.0.0` so
host apps bind to all interfaces, ensuring Traefik (running inside Docker) can reach them.

**Port detection timeout**: By default, devrouter waits up to 120 seconds for a host app
to start listening on a TCP port. For slow-starting dev servers, configure a custom
timeout per app in `.devrouter.yml`:

```yaml
hostRun:
  command: pnpm dev
  portTimeout: 180  # seconds
```

## 8) Golden path: host app + Docker Postgres

```bash
devrouter tls install
devrouter app run web
```

Why this order:

- Postgres hostname routing on shared `:5432` requires TLS/SNI.
- `devrouter app run web` starts declared Docker dependencies when confirmed/allowed.
- If configured hosts are not covered by the current cert SANs, `devrouter app run` auto-refreshes cert coverage before startup.
- Host dependencies are not auto-started in v1 and must be started manually.

For non-interactive runs:

```bash
devrouter app run web --yes
```

## 9) Run apps

```bash
devrouter app run web
```

If dependencies are declared, CLI prompts whether to start them.

For automation/non-interactive usage:

```bash
devrouter app run web --yes
```

## 9b) Run one-shot commands (migrations, seeds, etc.)

```bash
devrouter app exec web --yes -- npx prisma migrate dev
devrouter app exec web --yes -- npx prisma db seed
devrouter app exec web --yes -- printenv DB_URL DB_SHADOW_URL DB_HOST DB_PORT
```

This starts dependencies as needed, injects resolved per-dep env vars (plus any `envMap` aliases from config), and runs the command. It stops only dependencies started by that `exec` call; already-running services stay running.
If `<name>` is configured with `kind=dependency`, exec is rejected with guidance to run a routed parent app instead.

## 10) Enable TLS (required for TCP/Postgres, recommended for HTTP)

```bash
devrouter tls install
devrouter status
```

Then:

- HTTP routes resolve as `https://...`
- PostgreSQL routing is available on `:5432` via TLS/SNI hostnames
- Future `devrouter app run` / `devrouter app exec` calls auto-expand cert SAN coverage for configured repo hosts when needed.

## 11) Inspect routes

```bash
devrouter ls
```

You will see both:

- HTTP endpoints (`https://web.localhost`)
- TCP/Postgres endpoints (`postgres://db.localhost:5432 (tls required)`)

Table columns also include both configured app name (`APP`) and runtime service identity (`SERVICE`).

For TCP routes, `devrouter open <name>` prints connection guidance instead of launching browser.
`<name>` resolves by app name first, then service/container/host identities.
For `kind=dependency` app names, `devrouter open` returns a no-route guidance message.

## 12) View router logs (troubleshooting)

```bash
devrouter logs --tail 50
devrouter logs -f
```

Use `devrouter logs` to inspect Traefik access logs and diagnose routing issues (e.g. 502 bad gateway).

If a browser shows `TRAEFIK DEFAULT CERT` for a multi-segment `.localhost` host, run `devrouter app run <name> --yes` (auto-refresh) or `devrouter tls install`.

If `devrouter up` or dependency startup fails with `no space left on device`, free Docker disk space using your preferred method and retry the command.

For Next.js host-run apps using proxied/custom `.localhost` development hosts, verify the dev-origin host setting in `next.config.*` for your installed Next.js version (the exact option name changed across releases).

## 13) Validate setup quality (recommended)

Run check-only diagnostics against global state, machine prerequisites, route state, and repository config:

```bash
devrouter doctor --repo /absolute/path/to/repo
```

For AI/tooling integration:

```bash
devrouter doctor --repo /absolute/path/to/repo --json
```

When `.devcontainer/` exists, doctor also checks devnet aliases, published host ports, and proxy upstream alias matches.

## 14) Onboard another repository

- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)

Agent first pass:

```bash
devrouter setup --yes --json
devrouter doctor --json
devrouter repo inspect --repo /absolute/path/to/repo --json
devrouter repo devcontainer write --repo /absolute/path/to/repo --dry-run --json
devrouter repo devcontainer write --repo /absolute/path/to/repo --yes
devrouter repo devcontainer verify --repo /absolute/path/to/repo --json
```

For full local evidence, start the devcontainer and add the live verify summary
to the PR:

```bash
devpod up /absolute/path/to/repo
devrouter repo devcontainer verify --repo /absolute/path/to/repo --live --yes --json
```

## 15) Workspace isolation (parallel worktrees)

A **workspace token** lets multiple git worktrees of the same repo run concurrently without host or route collisions.

**Token resolution precedence** (highest to lowest):

1. `--workspace <slug>` CLI flag on `devrouter app run` / `devrouter app exec`
2. `DEVROUTER_WORKSPACE` environment variable
3. Auto-derived from the worktree's linked branch name (sanitized: lowercase, non-alphanumeric → `-`, capped at 32 chars)
4. None — the primary checkout carries no token and routes exactly as before (back-compatible)

**Effect of an active token:**

- Hosts are auto-namespaced in memory: `web.localhost` → `web.<ws>.localhost`
- `${WORKSPACE}` in a proxy app's `upstream` field is substituted with the token at runtime
- The committed `.devrouter.yml` is never modified
- TLS cert SANs are auto-extended for namespaced hosts when TLS is enabled

**Lifecycle commands:**

```bash
# Create a git worktree for a branch, bring up its devpod, register workspace routes
devrouter workspace up feat/my-feature

# Optional: specify a custom worktree path or skip devpod
devrouter workspace up feat/my-feature --path ../my-repo-feat --no-devpod

# List git worktrees with workspace tokens and active route counts
devrouter workspace ls

# Tear down: free routes, stop devpod, remove worktree
devrouter workspace down feat/my-feature

# Keep the worktree or devpod when tearing down
devrouter workspace down feat/my-feature --keep-worktree
devrouter workspace down feat/my-feature --keep-devpod
```

**devcontainer / proxy integration:**

A workspace-aware proxy app upstream uses the `${WORKSPACE}` placeholder so devrouter substitutes the active token at runtime:

```yaml
- name: app
  host: app.localhost
  protocol: http
  runtime: proxy
  upstream: ${WORKSPACE}-app:3000
```

With workspace `feat-a` active: host becomes `app.feat-a.localhost`, upstream resolves to `feat-a-app:3000`.

The devcontainer compose service should expose a network alias `${WORKSPACE}-app` (where `WORKSPACE` defaults to the project name in `devcontainer.env`).

**Orphan detection:** `devrouter doctor` check `routes.orphaned-workspace-routes` reports proxy routes whose worktree directory was deleted without `devrouter workspace down`. It does not mutate route state.
