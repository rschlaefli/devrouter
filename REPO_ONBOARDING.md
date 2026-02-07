# REPO_ONBOARDING.md

Guide for adapting an existing repository to use `devrouter`.

## 1) Purpose

This guide is for onboarding an existing app repository to `devrouter` using:

- Docker labels for Traefik routing
- shared Docker network `devnet`

Scope constraints:

- no Kubernetes
- no central service registry
- no random host-port selection for app access

Two supported onboarding modes:

- container mode (`dev add` + compose override)
- host-run mode (`devrouter.host.yml` + `dev host ...`)

## 2) Before You Start

Complete global setup first:

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)
- absolute path reference: `/Volumes/MOBILE/Git/devrouter/GETTING_STARTED.md`

Assumptions for this guide:

- `dev` CLI is installed
- `dev up` is available on your machine
- you are on macOS

## 3) Inputs You Must Decide Per Repo

For each app repo, choose:

- `mode`: `container` or `host`
- `hostname`: `<name>.localhost`

Container mode inputs:
- `service`: Compose service name to expose
- `internal port`: container port the app listens on
- `router id` (optional): Traefik router/service key override
- compose file layout: base compose file plus override (usually `docker-compose.yml` + `docker-compose.devrouter.yml`)

Host mode inputs:
- `route name` in `devrouter.host.yml`
- `command` to run dev server (for example `pnpm dev`)
- `cwd` for that command (repo root or subfolder)

## 4) Fast Path (Recommended)

Run in the target app repository:

```bash
dev add --service <service> --port <port> --host <hostname>.localhost
docker compose -f docker-compose.yml -f docker-compose.devrouter.yml up
```

`dev add` creates or updates `docker-compose.devrouter.yml`, which is the repo-local overlay used to connect your app to `devrouter`.

## 4.1) Host-Run Fast Path (App runs on Mac, not in Docker)

Create `<repo>/devrouter.host.yml`:

```yaml
version: 1
routes:
  - name: app
    host: app.localhost
    mode: host
    command: pnpm dev
    cwd: .
    strategy:
      type: auto
      denyPorts: [80, 443]
      allowPortRange: "1024-65535"
```

Then run one of:

```bash
dev host run --name app
```

or, if already running manually:

```bash
dev host attach --name app
```

The app can stay on a dynamic local port; `devrouter` keeps `app.localhost` mapped to the current port via Traefik.

## 5) What `dev add` Changes (Container Mode)

Expected overlay behavior:

- joins service to `devnet`
- adds Traefik labels with `Host(...)` rule
- sets Traefik load balancer internal port

Compact example:

```yaml
services:
  app:
    networks:
      - devnet
    labels:
      traefik.enable: "true"
      traefik.docker.network: devnet
      traefik.http.routers.app.rule: Host(`app.localhost`)
      traefik.http.routers.app.entrypoints: web,websecure
      traefik.http.routers.app.tls: "true"
      traefik.http.services.app.loadbalancer.server.port: "3000"
networks:
  devnet:
    external: true
```

## 5.1) What Host Mode Changes

`dev host run` and `dev host attach` do not change your repo compose files.

They update global devrouter state under `~/.config/devrouter`:

- `traefik/dynamic/host-routes.yml`: generated host routes for Traefik
- `host-routes-state.json`: tracked route metadata (repo, name, host, port, mode, pid)

## 6) Validation Checklist

- `dev ls` shows the service URL.
- `curl http://<host>.localhost` succeeds (or `https://...` after TLS setup).
- the app service does not require published host ports for browser access.
- no duplicate hostnames exist across running services.
- for host-run mode, `dev host ls` shows active route state.

## 7) TLS Path

Run:

```bash
dev tls install
```

Then confirm:

- `dev ls` reports `https://...` URLs
- certs are present under `~/.config/devrouter/certs`

## 8) Troubleshooting

Host 80/443 conflicts:

```bash
lsof -nP -iTCP:80 -sTCP:LISTEN
lsof -nP -iTCP:443 -sTCP:LISTEN
```

Missing route in `dev ls`:

- ensure service is on `devnet`
- ensure `traefik.enable=true`
- ensure `traefik.http.routers.*.rule=Host(\`<name>.localhost\`)`

Hostname mismatch or duplicates:

- use unique `*.localhost` hostnames per app
- rerun `dev ls` and resolve duplicate-host warnings

Resolver caveat for `.localhost`:

- see resolver notes in [`GETTING_STARTED.md`](./GETTING_STARTED.md) (section about `/etc/hosts` and wildcard behavior)

## 9) AI Agent Prompt (Single Copy-Paste)

Use this prompt with an AI coding agent to adapt another repo:

```text
You are adapting an existing repository to use our local devrouter setup.

Inputs:
- REPO_PATH=<REPO_PATH>
- MODE=<container|host>
- SERVICE_NAME=<SERVICE_NAME>                  # required for MODE=container
- INTERNAL_PORT=<INTERNAL_PORT>                # required for MODE=container
- ROUTE_NAME=<ROUTE_NAME>                      # required for MODE=host
- HOST_COMMAND=<HOST_COMMAND>                  # required for MODE=host (example: pnpm dev)
- HOST_CWD=<HOST_CWD_RELATIVE_TO_REPO>         # required for MODE=host (example: . or apps/web)
- HOSTNAME_LOCALHOST=<HOSTNAME_LOCALHOST>
- BASE_COMPOSE_FILE=<BASE_COMPOSE_FILE>        # required for MODE=container

Goals:
1) Inspect existing files first (compose and/or current dev scripts); do not assume structure.
2) Keep changes minimal, idempotent, and scoped to onboarding only.
3) Do not mutate unrelated services/files.
4) Always use *.localhost hostnames and avoid introducing published app host ports.
5) If ambiguity exists, stop and ask targeted questions.

If MODE=container:
1) Generate or update docker-compose.devrouter.yml in REPO_PATH.
2) Ensure target service joins external network devnet.
3) Ensure required labels exist:
   - traefik.enable=true
   - traefik.docker.network=devnet
   - traefik.http.routers.<router>.rule=Host(`<HOSTNAME_LOCALHOST>`)
   - traefik.http.services.<service>.loadbalancer.server.port=<INTERNAL_PORT>

If MODE=host:
1) Generate or update REPO_PATH/devrouter.host.yml.
2) Add/merge route entry:
   - name: <ROUTE_NAME>
   - host: <HOSTNAME_LOCALHOST>
   - mode: host
   - command: <HOST_COMMAND>
   - cwd: <HOST_CWD_RELATIVE_TO_REPO>
   - strategy.type: auto
   - strategy.denyPorts: [80, 443]
   - strategy.allowPortRange: "1024-65535"
3) Do not edit docker-compose files unless explicitly requested.

Validation commands to run and report:
- if MODE=container:
  - docker compose -f <BASE_COMPOSE_FILE> -f docker-compose.devrouter.yml config
  - docker compose -f <BASE_COMPOSE_FILE> -f docker-compose.devrouter.yml up -d
- if MODE=host:
  - dev host run --name <ROUTE_NAME> --repo <REPO_PATH>
- for both modes:
  - dev ls
  - curl -I http://<HOSTNAME_LOCALHOST>

Output format:
1) Summary of detected project structure and selected onboarding mode.
2) Exact files changed.
3) Concise diff summary.
4) Validation command outputs (or key excerpts).
5) Follow-up actions required from developer (if any).
```

## 10) Definition of Done

- repo starts with base + override compose command.
- app is reachable via stable `.localhost` hostname.
- `dev ls` lists the app route correctly.
- onboarding steps are reproducible by another engineer without tribal knowledge.

Future migration note:
- `devrouter.host.yml` is the current host-mode config.
- a unified `devrouter.yml` may be introduced later; this is planned to be backward-compatible.
