# devrouter

Local-first routing for multiple Docker Compose projects on macOS, without port juggling.

## Why this exists

When multiple projects run locally, they often clash on host ports (`3000`, `8080`, `5432`, etc.).
This project introduces one shared local router on `80/443` and routes apps by hostname:

- `app-a.localhost`
- `app-b.localhost`

No random host ports per app are required.

## Current MVP (implemented)

This repository now contains a TypeScript CLI (`dev`) with a deliberately small, explainable scope:

- `dev up` / `dev down`
- `dev status [--json]`
- `dev ls [--json]`
- `dev open <name>`
- `dev add --service <svc> --port <internalPort> ...`
- `dev tls install`
- `dev host run --name <route>`
- `dev host attach --name <route>`
- `dev host ls [--json]`
- `dev host rm --name <route>`

Core behavior:

- Manages shared Traefik stack under `~/.config/devrouter`
- Ensures shared Docker network `devnet` exists (bridge + attachable)
- Uses Docker labels as source of truth (no central registry file)
- Supports mkcert TLS for `localhost` and `*.localhost`
- Enables HTTP -> HTTPS redirect once TLS is installed
- Generates per-repo `docker-compose.devrouter.yml` via `dev add`
- Supports host-run app routing via per-repo `devrouter.host.yml`

## Architecture (minimal modules)

Code is intentionally modular but small:

- `src/cli.ts`: command registration and top-level UX
- `src/commands/*`: thin handlers only
- `src/core/router.ts`: router filesystem + Traefik templates + compose lifecycle
- `src/core/docker.ts`: Docker context/client/network/container helpers
- `src/core/routes.ts`: Traefik host-rule parsing + duplicate hostname detection
- `src/core/add-app.ts`: generate/update repo override file
- `src/core/tls.ts`: mkcert bootstrap + TLS activation
- `src/core/host-config.ts`: load/validate `devrouter.host.yml`
- `src/core/host-routes.ts`: persist generated host routes + Traefik host-routes file
- `src/core/host-process.ts`: run/attach process monitoring + dynamic port detection
- `src/core/output.ts`: human table + JSON output
- `src/types.ts`: shared types

## Getting Started

For prerequisites, install, localhost domain notes (`/etc/hosts`), first boot, and TLS setup:

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)

Repository onboarding (adapting any app repo to devrouter):

- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)

## Command reference

### `dev up`

- Ensures `devnet`
- Ensures router files in `~/.config/devrouter`
- Checks host port conflicts on `80/443`
- Starts Traefik stack with `docker compose -f ~/.config/devrouter/compose.yml up -d`

### `dev down`

- Stops shared router stack only

### `dev status [--json]`

Shows:

- active Docker context
- router container state
- port bindings (`80`, `443`, `8080`)
- `devnet` existence
- TLS config/cert state

### `dev ls [--json]`

Lists discovered routes from containers that:

- are connected to `devnet`
- have `traefik.enable=true`
- define router rules like `Host(\`name.localhost\`)`

Warns on duplicate hostnames.

### `dev open <name>`

Opens a route by service name, container name, or hostname (must resolve uniquely).

### `dev add --service ... --port ...`

Creates/updates `docker-compose.devrouter.yml` in the current repo:

- joins service to `devnet`
- adds Traefik labels
- sets load balancer target internal port

### `dev tls install`

- ensures `mkcert` (via Homebrew if needed)
- runs `mkcert -install`
- generates certs into `~/.config/devrouter/certs`
- updates Traefik dynamic TLS config + redirect

### `dev host run --name <route> [--repo <path>]`

- reads route config from `<repo>/devrouter.host.yml`
- starts the configured command
- detects active listening port (excluding `80/443`)
- maps stable host to `host.docker.internal:<detected-port>`

### `dev host attach --name <route> [--repo <path>]`

- attaches route syncing to an already running host process from config

### `dev host ls [--json]`

- lists host-route state currently managed by devrouter

### `dev host rm --name <route> [--repo <path>]`

- removes a generated host route entry from devrouter state

## Files managed under `~/.config/devrouter`

- `compose.yml`
- `traefik/traefik.yml`
- `traefik/dynamic/base.yml`
- `traefik/dynamic/host-routes.yml`
- `host-routes-state.json`
- `certs/localhost.pem`
- `certs/localhost-key.pem`
- `README.md` (state-local notes)

## Label contract for app services

`dev add` writes this model:

- `traefik.enable=true`
- `traefik.docker.network=devnet`
- `traefik.http.routers.<router>.rule=Host(\`<name>.localhost\`)`
- `traefik.http.services.<router>.loadbalancer.server.port=<internalPort>`

## Troubleshooting

### `dev up` fails due ports 80/443

Find blockers:

```bash
lsof -nP -iTCP:80 -sTCP:LISTEN
lsof -nP -iTCP:443 -sTCP:LISTEN
```

Stop conflicting process/container and retry `dev up`.

### No routes in `dev ls`

Check that service:

- is on `devnet`
- has `traefik.enable=true`
- has valid `Host(...)` rule label

### HTTPS not showing in `dev ls`

Run:

```bash
dev tls install
dev status
```

Ensure cert files exist in `~/.config/devrouter/certs`.

## Current validation summary

Validated during implementation:

- build and typecheck pass
- `dev status`, `dev ls`, `dev add`, `dev tls install` work
- duplicate hostname warning works
- route discovery works with labeled temporary test containers

Known environmental blocker observed on this machine:

- existing process was already binding `80/443`, preventing `dev up` from taking ownership until those ports are freed

## Future work

See `PLAN.md` for roadmap items (`db` helpers, optional DNS command, packaging/publishing, tests/CI).
