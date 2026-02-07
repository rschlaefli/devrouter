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

- `service`: Compose service name to expose
- `internal port`: container port the app listens on
- `hostname`: `<name>.localhost`
- `router id` (optional): Traefik router/service key override
- compose file layout: base compose file plus override (usually `docker-compose.yml` + `docker-compose.devrouter.yml`)

## 4) Fast Path (Recommended)

Run in the target app repository:

```bash
dev add --service <service> --port <port> --host <hostname>.localhost
docker compose -f docker-compose.yml -f docker-compose.devrouter.yml up
```

`dev add` creates or updates `docker-compose.devrouter.yml`, which is the repo-local overlay used to connect your app to `devrouter`.

## 5) What `dev add` Changes

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

## 6) Validation Checklist

- `dev ls` shows the service URL.
- `curl http://<host>.localhost` succeeds (or `https://...` after TLS setup).
- the app service does not require published host ports for browser access.
- no duplicate hostnames exist across running services.

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
- SERVICE_NAME=<SERVICE_NAME>
- INTERNAL_PORT=<INTERNAL_PORT>
- HOSTNAME_LOCALHOST=<HOSTNAME_LOCALHOST>
- BASE_COMPOSE_FILE=<BASE_COMPOSE_FILE>

Goals:
1) Inspect existing compose files first (do not assume structure).
2) Generate or update docker-compose.devrouter.yml in REPO_PATH.
3) Do not mutate unrelated services.
4) Ensure the target service joins external network devnet.
5) Ensure required labels exist:
   - traefik.enable=true
   - traefik.docker.network=devnet
   - traefik.http.routers.<router>.rule=Host(`<HOSTNAME_LOCALHOST>`)
   - traefik.http.services.<service>.loadbalancer.server.port=<INTERNAL_PORT>
6) Keep changes minimal and idempotent.
7) If repo ambiguity exists, stop and ask targeted questions.

Validation commands to run and report:
- docker compose -f <BASE_COMPOSE_FILE> -f docker-compose.devrouter.yml config
- docker compose -f <BASE_COMPOSE_FILE> -f docker-compose.devrouter.yml up -d
- dev ls
- curl -I http://<HOSTNAME_LOCALHOST>

Output format:
1) Summary of detected compose structure.
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
