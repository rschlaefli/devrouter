---
name: devrouter
description: Work with devrouter for local dev routing (HTTP + TCP/Postgres on shared ports)
user-invocable: false
---

# devrouter

Local dev routing via a shared Traefik reverse proxy. Provides stable `*.localhost` hostnames for HTTP apps and TCP/Postgres multiplexing on shared ports (80, 443, 5432).

## How it works

- Shared Traefik router owns host ports 80 (HTTP), 443 (HTTPS), 5432 (Postgres TCP).
- Per-repo config: `.devrouter.yml` (single source of truth).
- Global runtime artifacts: `~/.config/devrouter` (never edit manually).
- Hostnames must end with `.localhost` (lowercase alphanumeric + hyphens only).

## `.devrouter.yml` entry schema

```yaml
apps:
  - name: <string>          # unique within repo
    host: <name>.localhost
    protocol: http | tcp
    runtime: host | docker
    dependencies:            # optional
      - app: <other-name>

    # if runtime=host (protocol must be http):
    hostRun:
      command: <string>
      cwd: <string>          # relative to repo root, must not escape it
      portTimeout: 120       # seconds, optional
      strategy:
        type: auto
        denyPorts: [80, 443, 5432]
        allowPortRange: "1024-65535"

    # if runtime=docker:
    docker:
      service: <string>
      internalPort: <number>
      composeFiles: [<string>]  # relative to repo root
      router: <string>          # optional

    # if protocol=tcp:
    tcpProtocol: postgres    # required; runtime must be docker
```

Validation rules:
- `host` must end with `.localhost`
- `runtime=host` supports `protocol=http` only
- `protocol=tcp` requires `runtime=docker` and `tcpProtocol=postgres`
- Unknown keys rejected (strict schema)

## Docker compose requirements

- **Healthcheck required**: every dependency service must define a `healthcheck`. `docker compose up --wait` blocks until healthy; without one, wait returns immediately.
- **No published ports**: services must not publish host ports for devrouter-owned ports (80, 443, 5432). Avoid publishing ports at all -- devrouter handles routing via Traefik.
- **Postgres credentials**: use `POSTGRES_USER=prisma`, `POSTGRES_PASSWORD=prisma`, `POSTGRES_DB=prisma` and create a `shadow` database. devrouter injects `DATABASE_URL` / `SHADOW_DATABASE_URL` with these fixed credentials.

Example healthcheck:
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U prisma -d prisma"]
  interval: 5s
  timeout: 3s
  retries: 20
```

## Env var injection

When a host app depends on a TCP/Postgres Docker service, `dev app run` and `dev app exec` inject:

| Variable | Value |
|---|---|
| `<UPPER_NAME>_HOST` | `localhost` |
| `<UPPER_NAME>_PORT` | random mapped port |
| `DATABASE_URL` | `postgres://prisma:prisma@localhost:<port>/prisma` (postgres deps only) |
| `SHADOW_DATABASE_URL` | `postgres://prisma:prisma@localhost:<port>/shadow` (postgres deps only) |

Host apps also receive `PORT` (random free port), `HOSTNAME=0.0.0.0`, `HOST=0.0.0.0`.

## Commands

- `dev up` / `dev down`: start/stop shared Traefik router
- `dev status`: router/container/network/TLS health
- `dev doctor [--repo .]`: deep diagnostics (global + repo)
- `dev ls`: list active HTTP + TCP routes
- `dev open <name>`: open HTTP route or print TCP connection hint
- `dev logs [-f]`: Traefik access logs
- `dev tls install`: install mkcert certs, enable HTTPS + TCP/SNI
- `dev repo init`: create `.devrouter.yml`
- `dev repo agents`: write devrouter section in AGENTS.md + install this skill
- `dev app add`: add/update app entry in `.devrouter.yml`
- `dev app ls`: list app entries
- `dev app run <name>`: run app with dependency lifecycle
- `dev app exec <name> -- <cmd>`: one-shot command with resolved dep env
- `dev app rm <name>`: remove app entry

## Validation workflow

1. `dev doctor --repo .` -- check global + repo health
2. `dev app ls` -- verify entries match expectations
3. `dev ls` -- confirm routes are exposed
4. `curl -I http://<host>.localhost` -- HTTP reachability
5. For TCP/Postgres: use `dev open <name>` for connection hint

## Runtime behavior notes

- `dev app run` auto-starts Docker dependencies, waits for health, stops them on exit.
- Host-runtime dependencies are NOT auto-started (v1).
- Postgres on shared `:5432` requires TLS/SNI (`dev tls install`). Standard app clients should use the injected random port instead.
- `dev app exec` follows the same dep lifecycle for one-shot commands.
