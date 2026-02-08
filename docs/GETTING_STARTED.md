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

From `/Volumes/MOBILE/Git/devrouter`:

```bash
pnpm install
pnpm build
make install
```

This installs `~/bin/dev`.

If needed:

```bash
export PATH="$HOME/bin:$PATH"
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

For TCP routes, `dev open <name>` prints connection guidance instead of launching browser.

## 12) View router logs (troubleshooting)

```bash
dev logs --tail 50
dev logs -f
```

Use `dev logs` to inspect Traefik access logs and diagnose routing issues (e.g. 502 bad gateway).

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
