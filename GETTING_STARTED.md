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

## 7) Run apps

```bash
dev app run web
```

If dependencies are declared, CLI prompts whether to start them.

For automation/non-interactive usage:

```bash
dev app run web --yes
```

## 8) Enable TLS (recommended)

```bash
dev tls install
dev status
```

Then:

- HTTP routes resolve as `https://...`
- PostgreSQL routing is available on `:5432` via TLS/SNI hostnames

## 9) Inspect routes

```bash
dev ls
```

You will see both:

- HTTP endpoints (`https://web.localhost`)
- TCP/Postgres endpoints (`postgres://db.localhost:5432 (tls required)`)

For TCP routes, `dev open <name>` prints connection guidance instead of launching browser.

## 10) Legacy cutover

Legacy repo files are no longer used for new flows:

- `devrouter.host.yml`
- `docker-compose.devrouter.yml`

Legacy commands are deprecated with migration guidance:

- `dev add`
- `dev host ...`

## 11) Onboard another repository

- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)
