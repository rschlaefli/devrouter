# devrouter

Local-first routing for macOS development with one shared Traefik router.

## What it solves

Run multiple repos concurrently without manual port juggling:

- HTTP apps by hostname: `web.localhost`, `api.localhost`
- Databases (Postgres, Redis, MariaDB, MySQL) by hostname on their standard shared ports via TLS/SNI: `db.localhost`, `redis.localhost`

Traefik owns:

- `:80` (HTTP)
- `:443` (HTTPS)
- Shared protocol ports for activated databases (e.g. `:5432`, `:6379`, `:3306`)

## Unified repo config

Each repo now uses one file:

- `.devrouter.yml`

This is the only supported per-repo config for app routing/runtime definitions.

## Two ways to use devrouter

Both are configured the same way (`.devrouter.yml`) and can be mixed in one repo.

### 1. Front a devcontainer / existing process: `runtime: proxy` (preferred)

The recommended setup is devcontainer first. The devcontainer owns the toolchain,
databases, auth mocks, app process, and seed data. devrouter owns only the local
routes. In the best case the container joins `devnet` and exposes stable network
aliases, so the app and database need no published host ports.

```yaml
apps:
  - name: app
    host: myapp.localhost
    protocol: http
    runtime: proxy
    upstream: myapp-app:3000 # devnet alias inside the devcontainer compose
```

```bash
devrouter setup --yes
devpod up .
devrouter repo devcontainer verify --live --yes --json
```

Why prefer it: the environment is reproducible and runs anywhere the devcontainer
spec runs, while devrouter gives it stable local HTTPS and database hostnames.

We recommend **DevPod** to orchestrate the devcontainer lifecycle locally because:
- **IDE/Editor Independence**: DevPod manages the container lifecycle and code synchronization in the background, allowing developers to use any local editor (VS Code, JetBrains, vim) with the containerized toolchain.
- **No Vendor Lock-in**: It is a client-only, open-source runner that runs entirely locally on Docker without requiring Microsoft's proprietary VS Code extensions or cloud-based runners.
- **devrouter Integration**: DevPod spins up the devcontainer compose stack on the `devnet` network, and devrouter handles dynamic HTTPS domain routing (`*.localhost`), making manual port-forwarding management obsolete.

Agents can add the scaffold with `devrouter repo inspect`, `devrouter repo devcontainer write`,
and `devrouter repo devcontainer verify`, then include the JSON evidence in a PR. See
[`docs/DEVCONTAINER.md`](./docs/DEVCONTAINER.md) for the full reference.

### 2. devrouter runs everything — `runtime: host` / `runtime: docker`

The original mode: devrouter starts your app (`runtime: host`, via `hostRun`) and
manages its Docker datastores/dependencies (`runtime: docker`), injecting DB env
vars. Use it when you are not (yet) on a devcontainer. Fully supported.

## Core commands

- `devrouter init [--repo <path>] [--entries-json <json>] [--json] [--write-agents] [--write-skill]`
- `devrouter -V [--repo <path>]` (installed CLI version, local repo version, next upgrade target)
- `devrouter upgrade [version] [--repo <path>]`
- `devrouter setup --yes [--repo <path>] [--json]`
- `devrouter up`
- `devrouter down`
- `devrouter status [--repo <path>] [--json]`
- `devrouter doctor|verify [--repo <path>] [--json]`
- `devrouter ls [--json]`
- `devrouter open <name>` (matches app name, then service/container/host)
- `devrouter tls install`
- `devrouter repo init [--repo <path>]`
- `devrouter repo inspect [--repo <path>] [--json]`
- `devrouter repo devcontainer write [--repo <path>] [--dry-run] [--yes] [--json]`
- `devrouter repo devcontainer verify [--repo <path>] [--live] [--yes] [--json]`
- `devrouter repo agents [--repo <path>]`
- `devrouter app add ...` (`--kind app|dependency`, default `app`)
- `devrouter app ls [--repo <path>] [--json]`
- `devrouter app run <name> [--repo <path>] [--yes] [--workspace <slug>]`
- `devrouter app exec <name> [--repo <path>] [--yes] [--shell] [--env <env>] [--workspace <slug>] -- <command>`
- `devrouter app rm <name> [--repo <path>]`
- `devrouter logs [-f]`
- `devrouter workspace up <branch> [--path <dir>] [--no-devpod] [--open] [--repo <path>]`
- `devrouter workspace ls [--repo <path>] [--json]`
- `devrouter workspace down <workspace|branch> [--keep-worktree] [--keep-devpod] [--repo <path>]`

The current `devrouter repo devcontainer write` scaffold is intentionally narrow:
Node + pnpm + Postgres. Other package managers stop with a JSON diagnostic
instead of writing files that would need manual repair.
Use `devrouter repo devcontainer verify --json` for read-only PR evidence; add
`--live --yes` only after the devcontainer is running and route probes should
mutate local route state.

## Workspace isolation (parallel worktrees)

A **workspace token** lets several git worktrees of the same repo run side-by-side without host or route collisions. The token is a single identity spanning three layers: the devpod workspace id, the routes devrouter registers, and the `${WORKSPACE}` placeholder in `.devrouter.yml` proxy upstreams and devcontainer compose network aliases.

**Token resolution precedence** (highest to lowest):

1. `--workspace <slug>` CLI flag
2. `DEVROUTER_WORKSPACE` environment variable
3. Auto-derived from the linked git worktree's branch name (sanitized: lowercase, non-alphanumeric → `-`, capped at 32 chars)
4. None — the primary checkout uses no token and routes exactly as a plain repo (back-compatible)

**When a workspace token is active:**

- Hosts are auto-namespaced: `web.localhost` → `web.<ws>.localhost`
- `${WORKSPACE}` in a proxy app's `upstream` (e.g. `upstream: ${WORKSPACE}-app:3000`) is substituted with the token at runtime
- The committed `.devrouter.yml` is never rewritten — all namespacing is computed in memory
- TLS: namespaced hosts are not covered by `*.localhost`; devrouter auto-extends mkcert cert SANs for active workspace hosts

`${WORKSPACE}` is valid in `upstream` only. Using it in `host` is rejected (hosts are namespaced automatically).

**Typical workflow:**

```bash
# Bring up a feature branch as an isolated workspace
devrouter workspace up feat/my-feature

# List git worktrees with workspace tokens and route counts
devrouter workspace ls

# Tear down a workspace (stop devpod, remove worktree, free routes)
devrouter workspace down feat/my-feature
```

**devcontainer integration:** the devcontainer compose service exposes a devnet network alias `${WORKSPACE}-app` (defaulting to the project name in `devcontainer.env`); the proxy app uses `upstream: ${WORKSPACE}-app:<port>`. Workspace `feat-a` → alias `feat-a-app`, host `app.feat-a.localhost`.

**Try it:** [`examples/workspace/`](examples/workspace/) is a runnable showcase — `./run.sh` brings up one app in two parallel worktrees (`wsdemo.localhost` and `wsdemo.feat-a.localhost`) served at once, then `./run.sh down` tears it down.

**DevPod example:** [`examples/devcontainer/`](examples/devcontainer/) is the
agent-native devcontainer path end to end — `./run.sh` brings up a DevPod
workspace, registers app/Postgres proxy routes, runs static/live verification,
and prints the proof. `./run.sh down` tears it down.

**Orphan detection:** `devrouter doctor` check `routes.orphaned-workspace-routes` reports proxy routes whose worktree directory was removed without `devrouter workspace down`. It does not mutate route state.

## Upgrade metadata and prompts

`devrouter upgrade` and `devrouter -V` read local upgrade metadata from `.devrouter.yml` in the target repo (`devrouter.version`):

```yaml
version: 1
devrouter:
  version: <semver>
apps: []
```

Quick checks:

- `devrouter -V` shows installed CLI version, local repo version, and next available upgrade target.
- `devrouter upgrade` lists all upgrade targets newer than the local repo version and marks the next one.
- `devrouter upgrade <version>` prints that target release's Agent Adaptation Prompt and then shows if a further version is available.
- Upgrade prompts are sourced from `upgrade-prompts/<version>.md`.
- `devrouter repo init` initializes `devrouter.version` to the installed CLI version.

## AI-native onboarding prompt

Generate a ready-to-copy onboarding prompt for an AI agent:

```bash
devrouter init --repo /absolute/path/to/repo
```

By default, this command is non-mutating (it prints prompt text only).

Optional: embed target app entries as JSON:

```bash
devrouter init --repo /absolute/path/to/repo --entries-json '[{"name":"web","host":"web.localhost","protocol":"http","runtime":"host"}]'
```

JSON mode for machine consumption:

```bash
devrouter init --repo /absolute/path/to/repo --json
```

Optional repo artifact writes are explicit:

```bash
devrouter init --repo /absolute/path/to/repo --write-agents --write-skill
```

## Health diagnostics

Run check-only diagnostics for global router state, machine prerequisites, route state, and repo configuration:

```bash
devrouter doctor --repo /absolute/path/to/repo
```

Machine-friendly output:

```bash
devrouter doctor --repo /absolute/path/to/repo --json
```

`devrouter status` now includes readiness hints and next-step commands.
For host apps that depend on postgres, `devrouter doctor` also checks host command wrapper precedence and warns with `repo.host-command-env-precedence` when `DATABASE_URI`/`DATABASE_URL` is assigned before a `run --` wrapper boundary.
When TLS is enabled, `devrouter doctor` also checks TLS host coverage and warns with `repo.tls-host-coverage` if configured `.localhost` hosts are not covered by the current cert SANs.
When `.devcontainer/` exists, `devrouter doctor` checks devnet aliases, published host ports, and proxy upstream alias matches.
`devrouter doctor` reports stale host routes and orphaned workspace proxy routes without mutating route state.

## `.devrouter.yml` example

```yaml
version: 1
devrouter:
  version: 0.0.14
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
      - app: redis

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

  - name: redis
    kind: dependency
    runtime: docker
    docker:
      service: redis
      composeFiles:
        - docker-compose.yml

  # Route to an already-running port (e.g. a devcontainer's published app).
  # No lifecycle, env injection, or dependencies — devrouter only registers the route.
  # Use ${WORKSPACE} in upstream for parallel-worktree isolation (see "Workspace isolation").
  - name: app
    host: app.localhost
    protocol: http
    runtime: proxy
    upstream: 127.0.0.1:3000
    # upstream: ${WORKSPACE}-app:3000   # workspace-aware variant
```

Notes:

- `kind` defaults to routed app behavior. Use `kind: dependency` for non-routed Docker dependencies.
- `runtime: proxy` registers an HTTP route to an externally-managed `upstream` (`host:port`) and does nothing else — use it to put a stable `*.localhost` HTTPS host in front of a devcontainer or any process you start yourself. Loopback upstreams (`localhost`/`127.0.0.1`/`0.0.0.0`) are rewritten to `host.docker.internal` so Traefik (in Docker) can reach the host. The route persists until `devrouter app rm`.
- TCP routing supports `tcpProtocol: postgres`, `redis`, `mariadb`, and `mysql` on shared protocol ports with TLS/SNI.
- Plaintext TCP is not supported for multiplexed hostname routing.
- Multi-segment `.localhost` hosts are supported (for example `elearning.klicker.localhost`).

## Runtime behavior

`devrouter app run <name>`:

- reads `.devrouter.yml`
- prompts to start declared dependencies (or use `--yes`)
- starts docker target services for `runtime: docker` apps, plus declared docker dependencies
- for `runtime: proxy` apps: registers the route to `upstream` and returns immediately (no process started, no dependencies); re-running is an idempotent upsert and the route persists until `devrouter app rm`
- fails fast if host-runtime dependencies are configured (start those manually)
- waits for Docker dependencies to become healthy (`--wait`) before proceeding
- automatically stops Docker dependencies when a host app exits; docker app services remain running until explicit cleanup (`docker compose down`, `devrouter down`, or equivalent)
- prints recent dependency logs (last 20 lines) after deps start
- `kind=dependency` apps are dependency-only: they do not create routes and cannot be direct targets for `devrouter app run`, `devrouter app exec`, or `devrouter open`
- `kind=dependency` services start as declared in compose (no Traefik labels, no random published ports, no injected env vars)
- for TCP deps of host apps: publishes a random host port and injects per-dependency `<NAME>_HOST`/`<NAME>_PORT`/`<NAME>_URL` env vars into the host process; for postgres deps also injects `<NAME>_SHADOW_URL` (fixed credentials `prisma:prisma`, databases `prisma`/`shadow`)
- for one-shot commands, `devrouter app exec` starts declared docker deps as needed and only stops deps it started in that invocation (already-running deps stay running)
- if `devrouter app exec` cannot determine pre-existing running services, it leaves selected deps running to avoid stopping non-owned services
- when TLS is enabled, `devrouter app run` / `devrouter app exec` auto-refresh cert SAN coverage for configured repo hosts before startup (fails fast with `Run: devrouter tls install` guidance if refresh fails)
- for one-shot commands, `devrouter app exec` preserves argv semantics by default (`shell: false`) to avoid nested quoting issues
- `devrouter app exec --shell` is explicit and requires one command string after `--`
- config-level `envMap` on dependency references maps aliases after dependency env resolution (for example `DATABASE_URL: DB_URL`)
- starts host app command for host runtime apps
- generates docker overlay in `~/.config/devrouter/cache/...` for docker runtime apps

Secret manager interop (Infisical/Doppler):

- dependency env injection from devrouter includes `<NAME>_HOST`, `<NAME>_PORT`, `<NAME>_URL`, and postgres-only `<NAME>_SHADOW_URL`
- do not assume secret-manager precedence when DB vars overlap; validate effective env before migrate/seed
- avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values
- map app-specific names in `.devrouter.yml`:
  ```yaml
  dependencies:
    - app: db
      envMap:
        DATABASE_URL: DB_URL
        DIRECT_URL: DB_URL
        SHADOW_DATABASE_URL: DB_SHADOW_URL
  ```
- safe host-run override pattern when wrapper also defines `DATABASE_URI`: `infisical run --projectId <id> --env=<env> -- env DATABASE_URI=${DB_URL:?missing DB_URL} pnpm dev`
- non-Prisma mapping example: `devrouter app exec web --yes -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate`
- env probe example: `devrouter app exec web --yes -- printenv DB_URL DATABASE_URL DB_HOST DB_PORT DB_SHADOW_URL SHADOW_DATABASE_URL`
- run `devrouter doctor --repo <path>` to surface risky wrapper precedence (`repo.host-command-env-precedence`) before migrations or app startup

`devrouter ls` output includes both configured app identity (`APP`) and runtime service identity (`SERVICE`).

## First onboarding quick path

In a repo that has a host app and a Docker Postgres service:

```bash
devrouter repo init
devrouter app add --name web --host web.localhost --protocol http --runtime host --command "pnpm dev" --cwd .
devrouter app add --name db --host db.localhost --protocol tcp --runtime docker --tcp-protocol postgres --service db --port 5432 --compose-file docker-compose.yml
devrouter app add --name redis --kind dependency --service redis --compose-file docker-compose.yml
devrouter app add --name web --host web.localhost --protocol http --runtime host --command "pnpm dev" --cwd . --depends-on db --depends-on redis
devrouter tls install
devrouter app run web --yes
devrouter ls
```

Expected endpoints:

- `https://web.localhost`
- `postgres://db.localhost:5432 (tls required)`

## Routing example (without devcontainers)

A complete no-devcontainer sample repository is included at:

- [`./examples/routing`](./examples/routing)

It contains:

- one app running on host (`web-host`)
- the same app running in Docker (`web-docker`)
- Postgres in Docker (`db`)
- ready-to-use `.devrouter.yml`

Run the bundled routing smoke:

```bash
pnpm routing:smoke
```

Run the live DevPod/devcontainer smoke when Docker, DevPod, and mkcert are
available:

```bash
pnpm devcontainer:smoke
pnpm devcontainer:smoke down
```

See details:

- [`./examples/routing/README.md`](./examples/routing/README.md)
- [`./examples/devcontainer/README.md`](./examples/devcontainer/README.md)

## AI agent discoverability

`devrouter repo agents` writes a devrouter section into the repo's `AGENTS.md` and installs a skill file at `.agents/skills/devrouter/SKILL.md`. The skill content is embedded in the CLI bundle so it stays in sync across repos.

## Known limitations (v1)

- Host-runtime dependencies are not auto-started; only Docker dependencies are auto-started.
- `kind=dependency` apps are not direct run/exec/open targets (must be started via a routed app dependency graph).
- TCP routing supports `tcpProtocol: postgres`, `redis`, `mariadb`, and `mysql`.
- Shared TCP hostname multiplexing requires TLS/SNI (`sslmode=require` or protocol-equivalent client SNI).

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
- Routing example: [`./examples/routing/README.md`](./examples/routing/README.md)
- Roadmap: [`docs/PLAN.md`](./docs/PLAN.md)
- Release and adaptation history: [`CHANGELOG.md`](./CHANGELOG.md) and [`upgrade-prompts/`](./upgrade-prompts/)
