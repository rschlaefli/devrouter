# GETTING_STARTED.md

Setup and first-run guide for `devrouter` using the unified `.devrouter.yml` model.

## 1) Prerequisites

- macOS
- Docker daemon + CLI
- Node `>=22`
- pnpm
- Homebrew (recommended for automatic mkcert install)

Quick checks:

```bash
docker --version
docker context show
node -v
pnpm -v
```

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

Optional: run bundled smoke demo (host app + docker app + postgres):

```bash
pnpm demo:smoke
```

Demo assets live in:

- [`../demo/README.md`](../demo/README.md)

Release and adaptation notes live in [`../CHANGELOG.md`](../CHANGELOG.md).

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

Services **should not** publish host ports at all. devrouter handles external routing via Traefik labels. Publishing ports creates conflicts when running multiple repos. Use devrouter hostnames (e.g. `demo-db.localhost:5432`) instead of `localhost:<mapped-port>`.

### Dependency lifecycle

- `dev app run` waits for Docker dependencies to become healthy before starting the host app
- Docker dependencies are automatically stopped when the host app exits (Ctrl+C or error)
- Recent dependency logs (last 20 lines) are printed after dependencies start

### TCP dependency port injection

When a host app depends on a TCP/Postgres Docker service, `dev app run` automatically:

1. Publishes the service's internal port on a random host port
2. Queries the mapped port after startup
3. Injects `<UPPER_NAME>_HOST=localhost` and `<UPPER_NAME>_PORT=<port>` env vars into the host app process
4. For postgres deps, also injects `DATABASE_URL` and `SHADOW_DATABASE_URL` with fixed credentials

For example, a dependency named `db` produces:

- `DB_HOST=localhost`
- `DB_PORT=54321`
- `DATABASE_URL=postgres://prisma:prisma@localhost:54321/prisma`
- `SHADOW_DATABASE_URL=postgres://prisma:prisma@localhost:54321/shadow`

Prisma projects work out of the box. Other frameworks can use `DATABASE_URL` directly or override it.

### Running one-shot commands with dependency env vars

`dev app exec` starts dependencies, resolves env vars, runs a single command, then stops dependencies. Use it for migrations, seeding, or any CLI tool that needs the resolved env:

```bash
dev app exec web --yes -- npx prisma migrate dev
dev app exec web --yes -- npx prisma db seed
dev app exec web --yes -- printenv DATABASE_URL SHADOW_DATABASE_URL DB_HOST DB_PORT
```

The command receives the same env vars as `dev app run` (DATABASE_URL, SHADOW_DATABASE_URL, _HOST, _PORT).
By default, exec preserves argv semantics (`shell: false`) so nested commands like `infisical run -- ...` stay stable without wrapper recursion.

Use `--shell` only when shell expansion is required, and pass exactly one command string after `--`:

```bash
dev app exec web --yes --shell -- "echo $DATABASE_URL"
```

Map aliases for non-Prisma apps with repeatable `--env-map TARGET=SOURCE`:

```bash
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- pnpm payload migrate
```

### Secret manager interop (Infisical/Doppler)

- devrouter injects `DB_HOST`, `DB_PORT`, `DATABASE_URL`, and `SHADOW_DATABASE_URL` when a host app depends on postgres.
- If your secret manager also defines DB variables, do not assume precedence. Validate effective env before migration/seed.
- Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values.
- Safe host-run override pattern when wrapper also defines `DATABASE_URI`: `infisical run --projectId <id> --env=<env> -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} pnpm dev`.
- Deterministic mapping for Payload/non-Prisma apps: `--env-map DATABASE_URI=DATABASE_URL`.
- Recommended probe:

```bash
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL
```

- Recommended one-shot migrate:

```bash
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate
```

- `dev doctor --repo <path>` warns on risky pre-wrapper DB assignments for host apps with postgres dependencies (`repo.host-command-env-precedence`).

Compatibility note: older versions flattened `dev app exec` commands into a shell string; use the argv-safe form above on `v0.0.7+`.

The TLS/SNI route on `:5432` remains available for tools that support `sslnegotiation=direct` (psql 17+, pgAdmin).

## 3) Localhost resolution notes

- Modern browsers resolve `*.localhost` to loopback.
- `/etc/hosts` does not support wildcard records.
- This tool does not mutate system DNS files in MVP.

Fallback for specific hostnames only:

```text
127.0.0.1 app.localhost
127.0.0.1 db.localhost
```

## 4) Start shared router

```bash
dev up
dev status
dev doctor
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
dev repo init
```

This creates:

- `.devrouter.yml`

To write a devrouter section into the repo's `AGENTS.md` and install the devrouter skill:

```bash
dev repo agents
```

This creates:

- `AGENTS.md` section referencing devrouter (idempotent — skips if present)
- `.factory/skills/devrouter/SKILL.md` (always overwritten with latest content)

The skill file contains full config schema, docker requirements, env injection behavior, and command reference.

To also install optional Linear workflow planning assets:

```bash
dev repo agents --with-linear
```

This additionally creates:

- `.factory/skills/linear-workflow/SKILL.md`
- `.factory/skills/linear-workflow/references/LINEAR_ISSUE_TEMPLATE.md`
- `.factory/skills/linear-workflow/references/MILESTONE_PLAN_TEMPLATE.md`
- `.factory/skills/linear-workflow/references/PROGRESS_UPDATE_TEMPLATE.md`
- `AGENTS.md` linear-workflow section (idempotent)
- `AGENTS.md` managed Linear mapping block (`workspace/team/project`) between:
  - `<!-- devrouter-linear-workflow-config:start -->`
  - `<!-- devrouter-linear-workflow-config:end -->`

If running without an interactive TTY, devrouter writes placeholder mapping values and prints a warning.

Required Linear execution hygiene:

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

## 6) Generate onboarding prompt for an AI agent (optional)

From the target repository:

```bash
dev init
```

Or from elsewhere:

```bash
dev init --repo /absolute/path/to/repo
```

This prints the canonical onboarding prompt with the repository path injected.

`dev init` is non-mutating by default. To also write artifacts in one command, pass explicit flags:

```bash
dev init --repo /absolute/path/to/repo --write-agents --write-skill
```

To include optional Linear workflow guidance/artifacts:

```bash
dev init --repo /absolute/path/to/repo --with-linear --write-agents --write-skill
```

With `--with-linear` + AGENTS writes, devrouter asks:

- Linear workspace name
- Linear team name (optional team key)
- Linear project name (optional project id)

## 7) Add apps to `.devrouter.yml`

HTTP host-run app:

```bash
dev app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd .
```

PostgreSQL docker app:

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

Optional dependency link:

```bash
dev app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd . \
  --depends-on db
```

## Host app runtime behavior

**PORT injection**: `dev app run` automatically injects a `PORT` environment variable
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
dev tls install
dev app run web
```

Why this order:

- Postgres hostname routing on shared `:5432` requires TLS/SNI.
- `dev app run web` starts declared Docker dependencies when confirmed/allowed.
- Host dependencies are not auto-started in v1 and must be started manually.

For non-interactive runs:

```bash
dev app run web --yes
```

## 9) Run apps

```bash
dev app run web
```

If dependencies are declared, CLI prompts whether to start them.

For automation/non-interactive usage:

```bash
dev app run web --yes
```

## 9b) Run one-shot commands (migrations, seeds, etc.)

```bash
dev app exec web --yes -- npx prisma migrate dev
dev app exec web --yes -- npx prisma db seed
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate
dev app exec web --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL
```

This starts dependencies, injects resolved env vars, runs the command, and stops dependencies on exit.

## 10) Enable TLS (required for TCP/Postgres, recommended for HTTP)

```bash
dev tls install
dev status
```

Then:

- HTTP routes resolve as `https://...`
- PostgreSQL routing is available on `:5432` via TLS/SNI hostnames

## 11) Inspect routes

```bash
dev ls
```

You will see both:

- HTTP endpoints (`https://web.localhost`)
- TCP/Postgres endpoints (`postgres://db.localhost:5432 (tls required)`)

Table columns also include both configured app name (`APP`) and runtime service identity (`SERVICE`).

For TCP routes, `dev open <name>` prints connection guidance instead of launching browser.
`<name>` resolves by app name first, then service/container/host identities.

## 12) View router logs (troubleshooting)

```bash
dev logs --tail 50
dev logs -f
```

Use `dev logs` to inspect Traefik access logs and diagnose routing issues (e.g. 502 bad gateway).

If `dev up` or dependency startup fails with `no space left on device`, free Docker disk space using your preferred method and retry the command.

For Next.js host-run apps using proxied/custom `.localhost` development hosts, verify the dev-origin host setting in `next.config.*` for your installed Next.js version (the exact option name changed across releases).

## 13) Validate setup quality (recommended)

Run diagnostics against global state + repository config:

```bash
dev doctor --repo /absolute/path/to/repo
```

For AI/tooling integration:

```bash
dev doctor --repo /absolute/path/to/repo --json
```

## 14) Onboard another repository

- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)
