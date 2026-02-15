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
- `dev up`
- `dev down`
- `dev status [--repo <path>] [--json]`
- `dev doctor|verify [--repo <path>] [--json]`
- `dev ls [--json]`
- `dev open <name>` (matches app name, then service/container/host)
- `dev tls install`
- `dev repo init [--repo <path>]`
- `dev repo agents [--repo <path>] [--with-linear]`
- `dev app add ...`
- `dev app ls [--repo <path>] [--json]`
- `dev app run <name> [--repo <path>] [--yes]`
- `dev app exec <name> [--repo <path>] [--yes] [--shell] [--env-map TARGET=SOURCE] -- <command>`
- `dev app rm <name> [--repo <path>]`
- `dev logs [-f]`

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
- waits for Docker dependencies to become healthy (`--wait`) before proceeding
- automatically stops Docker dependencies when the host app exits
- prints recent dependency logs (last 20 lines) after deps start
- for TCP deps of host apps: publishes a random host port and injects `<NAME>_HOST`/`<NAME>_PORT` env vars into the host process; for postgres deps also injects `DATABASE_URL` and `SHADOW_DATABASE_URL` (fixed credentials `prisma:prisma`, databases `prisma`/`shadow`)
- for one-shot commands, `dev app exec` preserves argv semantics by default (`shell: false`) to avoid nested quoting issues
- `dev app exec --shell` is explicit and requires one command string after `--`
- `dev app exec --env-map TARGET=SOURCE` (repeatable) maps aliases after dependency env resolution (for example `DATABASE_URI=DATABASE_URL`)
- starts host app command for host runtime apps
- generates docker overlay in `~/.config/devrouter/cache/...` for docker runtime apps

Secret manager interop (Infisical/Doppler):

- dependency env injection from devrouter includes `<NAME>_HOST`, `<NAME>_PORT`, `DATABASE_URL`, and `SHADOW_DATABASE_URL`
- do not assume secret-manager precedence when DB vars overlap; validate effective env before migrate/seed
- non-Prisma mapping example: `dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate`
- env probe example: `dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL`

`dev ls` output includes both configured app identity (`APP`) and runtime service identity (`SERVICE`).

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
