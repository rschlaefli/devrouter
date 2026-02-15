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

- `dev init [--repo <path>] [--entries-json <json>] [--json] [--write-agents] [--write-skill] [--with-linear]`
- `dev -V [--repo <path>]` (installed CLI version, local repo version, next upgrade target)
- `dev upgrade [version] [--repo <path>]`
- `dev up`
- `dev down`
- `dev status [--repo <path>] [--json]`
- `dev doctor|verify [--repo <path>] [--json]`
- `dev ls [--json]`
- `dev open <name>` (matches app name, then service/container/host)
- `dev tls install`
- `dev repo init [--repo <path>]`
- `dev repo agents [--repo <path>] [--with-linear]`
- `dev app add ...` (`--kind app|dependency`, default `app`)
- `dev app ls [--repo <path>] [--json]`
- `dev app run <name> [--repo <path>] [--yes]`
- `dev app exec <name> [--repo <path>] [--yes] [--shell] [--env-map TARGET=SOURCE] -- <command>`
- `dev app rm <name> [--repo <path>]`
- `dev logs [-f]`

## Upgrade metadata and prompts

`dev upgrade` and `dev -V` read local upgrade metadata from `devrouter.yaml` in the target repo.
Use one of these supported forms:

```yaml
version: <semver>
```

```yaml
devrouter:
  version: <semver>
```

Quick checks:

- `dev -V` shows installed CLI version, local repo version, and next available upgrade target.
- `dev upgrade` lists all upgrade targets newer than the local repo version and marks the next one.
- `dev upgrade <version>` prints that target release's Agent Adaptation Prompt and then shows if a further version is available.

## AI-native onboarding prompt

Generate a ready-to-copy onboarding prompt for an AI agent:

```bash
dev init --repo /absolute/path/to/repo
```

By default, this command is non-mutating (it prints prompt text only).

Optional: embed target app entries as JSON:

```bash
dev init --repo /absolute/path/to/repo --entries-json '[{"name":"web","host":"web.localhost","protocol":"http","runtime":"host"}]'
```

JSON mode for machine consumption:

```bash
dev init --repo /absolute/path/to/repo --json
```

Optional repo artifact writes are explicit:

```bash
dev init --repo /absolute/path/to/repo --write-agents --write-skill
```

Optional: also bootstrap Linear workflow skill/templates and AGENTS section:

```bash
dev init --repo /absolute/path/to/repo --with-linear --write-agents --write-skill
```

When `--with-linear` is combined with AGENTS writes, devrouter captures minimal Linear mapping (workspace, team, project). In non-interactive mode it writes placeholders and prints a warning so values can be filled in later.

## Health diagnostics

Run deep checks for global router state and repo configuration:

```bash
dev doctor --repo /absolute/path/to/repo
```

Machine-friendly output:

```bash
dev doctor --repo /absolute/path/to/repo --json
```

`dev status` now includes readiness hints and next-step commands.
For host apps that depend on postgres, `dev doctor` also checks host command wrapper precedence and warns with `repo.host-command-env-precedence` when `DATABASE_URI`/`DATABASE_URL` is assigned before a `run --` wrapper boundary.
When TLS is enabled, `dev doctor` also checks TLS host coverage and warns with `repo.tls-host-coverage` if configured `.localhost` hosts are not covered by the current cert SANs.

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
```

Notes:

- `kind` defaults to routed app behavior. Use `kind: dependency` for non-routed Docker dependencies.
- TCP mode currently supports PostgreSQL first (`tcpProtocol: postgres`).
- Multi-DB hostname routing on shared `:5432` requires TLS/SNI.
- Plaintext Postgres is not supported for multiplexed hostname routing.
- Multi-segment `.localhost` hosts are supported (for example `elearning.klicker.localhost`).

## Runtime behavior

`dev app run <name>`:

- reads `.devrouter.yml`
- prompts to start declared dependencies (or use `--yes`)
- starts only declared docker dependency services
- fails fast if host-runtime dependencies are configured (start those manually)
- waits for Docker dependencies to become healthy (`--wait`) before proceeding
- automatically stops Docker dependencies when the host app exits
- prints recent dependency logs (last 20 lines) after deps start
- `kind=dependency` apps are dependency-only: they do not create routes and cannot be direct targets for `dev app run`, `dev app exec`, or `dev open`
- `kind=dependency` services start as declared in compose (no Traefik labels, no random published ports, no injected env vars)
- for TCP deps of host apps: publishes a random host port and injects `<NAME>_HOST`/`<NAME>_PORT` env vars into the host process; for postgres deps also injects `DATABASE_URL` and `SHADOW_DATABASE_URL` (fixed credentials `prisma:prisma`, databases `prisma`/`shadow`)
- for one-shot commands, `dev app exec` starts declared docker deps as needed and only stops deps it started in that invocation (already-running deps stay running)
- if `dev app exec` cannot determine pre-existing running services, it leaves selected deps running to avoid stopping non-owned services
- when TLS is enabled, `dev app run` / `dev app exec` auto-refresh cert SAN coverage for configured repo hosts before startup (fails fast with `Run: dev tls install` guidance if refresh fails)
- for one-shot commands, `dev app exec` preserves argv semantics by default (`shell: false`) to avoid nested quoting issues
- `dev app exec --shell` is explicit and requires one command string after `--`
- `dev app exec --env-map TARGET=SOURCE` (repeatable) maps aliases after dependency env resolution (for example `DATABASE_URI=DATABASE_URL`)
- starts host app command for host runtime apps
- generates docker overlay in `~/.config/devrouter/cache/...` for docker runtime apps

Secret manager interop (Infisical/Doppler):

- dependency env injection from devrouter includes `<NAME>_HOST`, `<NAME>_PORT`, `DATABASE_URL`, and `SHADOW_DATABASE_URL`
- do not assume secret-manager precedence when DB vars overlap; validate effective env before migrate/seed
- avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values
- safe host-run override pattern when wrapper also defines `DATABASE_URI`: `infisical run --projectId <id> --env=<env> -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} pnpm dev`
- non-Prisma mapping example: `dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate`
- env probe example: `dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL`
- run `dev doctor --repo <path>` to surface risky wrapper precedence (`repo.host-command-env-precedence`) before migrations or app startup

`dev ls` output includes both configured app identity (`APP`) and runtime service identity (`SERVICE`).

## First onboarding quick path

In a repo that has a host app and a Docker Postgres service:

```bash
dev repo init
dev app add --name web --host web.localhost --protocol http --runtime host --command "pnpm dev" --cwd .
dev app add --name db --host db.localhost --protocol tcp --runtime docker --tcp-protocol postgres --service db --port 5432 --compose-file docker-compose.yml
dev app add --name redis --kind dependency --service redis --compose-file docker-compose.yml
dev app add --name web --host web.localhost --protocol http --runtime host --command "pnpm dev" --cwd . --depends-on db --depends-on redis
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

## AI agent discoverability

`dev repo agents` writes a devrouter section into the repo's `AGENTS.md` and installs a skill file at `.factory/skills/devrouter/SKILL.md`. The skill content is embedded in the CLI bundle so it stays in sync across repos.

If you also want Linear workflow assets and repository mapping metadata, run:

```bash
dev repo agents --with-linear
```

This additionally installs:

- `.factory/skills/linear-workflow/SKILL.md`
- `.factory/skills/linear-workflow/references/LINEAR_ISSUE_TEMPLATE.md`
- `.factory/skills/linear-workflow/references/MILESTONE_PLAN_TEMPLATE.md`
- `.factory/skills/linear-workflow/references/PROGRESS_UPDATE_TEMPLATE.md`

and appends an idempotent `linear-workflow` section to `AGENTS.md`.

With `--with-linear`, AGENTS also stores a managed config block:

- `<!-- devrouter-linear-workflow-config:start -->`
- `<!-- devrouter-linear-workflow-config:end -->`

The block captures:

- `workspace.name`
- `team.name` (optional `team.key`)
- `project.name` (optional `project.id`)

Required Linear execution hygiene:

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

## Known limitations (v1)

- Host-runtime dependencies are not auto-started; only Docker dependencies are auto-started.
- `kind=dependency` apps are not direct run/exec/open targets (must be started via a routed app dependency graph).
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
- Release and adaptation history: [`CHANGELOG.md`](./CHANGELOG.md)
