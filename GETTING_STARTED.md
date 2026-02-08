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

- [`./demo/README.md`](./demo/README.md)

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

## 6) Add apps to `.devrouter.yml`

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

## 7) Golden path: host app + Docker Postgres

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

## 8) Run apps

```bash
dev app run web
```

If dependencies are declared, CLI prompts whether to start them.

For automation/non-interactive usage:

```bash
dev app run web --yes
```

## 9) Enable TLS (required for TCP/Postgres, recommended for HTTP)

```bash
dev tls install
dev status
```

Then:

- HTTP routes resolve as `https://...`
- PostgreSQL routing is available on `:5432` via TLS/SNI hostnames

## 10) Inspect routes

```bash
dev ls
```

You will see both:

- HTTP endpoints (`https://web.localhost`)
- TCP/Postgres endpoints (`postgres://db.localhost:5432 (tls required)`)

For TCP routes, `dev open <name>` prints connection guidance instead of launching browser.

## 11) Legacy cutover

Legacy repo files are no longer used for new flows:

- `devrouter.host.yml`
- `docker-compose.devrouter.yml`

Legacy commands are deprecated with migration guidance:

- `dev add`
- `dev host ...`

## 12) Onboard another repository

- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)
