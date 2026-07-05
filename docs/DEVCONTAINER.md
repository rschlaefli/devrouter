# Fronting a devcontainer with devrouter

The preferred way to use devrouter going forward. The **devcontainer owns the
environment**; devrouter is a thin **routing layer** that gives it stable,
TLS-terminated `*.localhost` hosts on the shared `:443` / `:5432` / `:6379` —
with **no published host ports**, so many devcontainers run at once with zero
collisions.

Clean split of responsibilities:

| Concern | Owner |
| --- | --- |
| Toolchain, databases, auth mocks, app process, install, seed | the devcontainer |
| `*.localhost` hostnames, HTTPS/TLS, shared `:443`, `:5432`/`:6379` SNI | devrouter |

This works with any devcontainer-spec runner (DevPod, VS Code Dev Containers,
`@devcontainers/cli`, Codespaces) — the container just needs to join `devnet`.

> Requires devrouter ≥ 0.0.21 (TCP proxy routes). The end-to-end onboarding
> playbook + reference templates + gotchas live in the
> `devcontainer-onboarding` skill (`.agents/skills/devcontainer-onboarding/`).

Agent-native onboarding uses the CLI first:

```bash
devrouter setup --yes --json
devrouter doctor --json
devrouter repo inspect --json
devrouter repo devcontainer write --dry-run --json
devrouter repo devcontainer write --yes
devrouter repo devcontainer verify --json
```

Use `devrouter repo devcontainer verify --live --yes --json` only after the
devcontainer is running and route registration plus HTTP probes should be part
of the evidence.

## How it works: `devnet`

devrouter's Traefik runs in Docker on a shared external bridge network,
`devnet`, with a file-provider config it hot-reloads. Any container that joins
`devnet` with a stable network **alias** is reachable by Traefik over the
network — **no host port**. devrouter demuxes by hostname: `Host()` for HTTP,
`HostSNI()` (TLS SNI) for TCP. So N apps + their databases all share `:443` /
`:5432` / `:6379`, separated by hostname.

## 1. Join the devcontainer services to `devnet`

In `.devcontainer/docker-compose.yml`, attach each routable service to the
external `devnet` network with a stable alias, and **drop all `ports:`
publishes**:

```yaml
services:
  app:
    networks:
      default: {}
      devnet:
        aliases: [myapp-app]
  postgres:
    networks:
      default: {}
      devnet:
        aliases: [myapp-db]
networks:
  devnet:
    external: true   # created by `devrouter setup`/`devrouter up`; must pre-exist when the stack starts
```

An OIDC mock or other sidecar that uses `network_mode: service:app` rides the
app's netns, so it is reachable on `devnet` as `myapp-app:<its-port>` — no
separate alias needed.

## 2. Declare proxy routes in `.devrouter.yml`

```yaml
version: 1
devrouter:
  version: 0.0.21 # proxy + protocol: tcp requires >= 0.0.21
project:
  name: myapp
apps:
  - name: app                       # https://myapp.localhost
    host: myapp.localhost
    protocol: http
    runtime: proxy
    upstream: myapp-app:3000        # devnet alias : internal port
  - name: db                        # db.myapp.localhost:5432
    host: db.myapp.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: proxy
    upstream: myapp-db:5432
```

A proxy app only registers a route — no `hostRun`, `docker`, `dependencies`, or
`secretManager`. The `upstream` is a devnet alias (`name:port`) resolved by
Traefik over the network. (A loopback upstream like `127.0.0.1:3000` still works
and is rewritten to `host.docker.internal`, but then every app competes for that
host port — the devnet alias is the collision-free path.)

## 3. Bring up routing

Order matters — `devnet` is `external`, so it must exist before the container
starts:

```bash
devrouter setup --yes
devrouter doctor --json
devpod up .
devrouter repo devcontainer verify --live --yes --json
```

`verify --live` registers proxy routes and probes HTTP routes, so it doubles as
agent PR evidence. For a manual route-only path, run `devrouter app run <name> --yes`
for each proxy app instead. A proxy app route starts no process. The container
owns start and stop. Routes persist until `devrouter app rm <name> --keep-config`.

Open `https://myapp.localhost`.

## 4. Connecting to a TCP route (Postgres / Redis)

TCP routes are demuxed by the SNI in the TLS ClientHello, so the client must
start TLS immediately:

```bash
# Postgres — direct-SSL (libpq 17+) so the ClientHello carries the SNI:
psql "host=db.myapp.localhost port=5432 user=<user> password=<pass> \
      dbname=<db> sslmode=require sslnegotiation=direct"

# Redis — TLS + explicit SNI, trusting the mkcert CA:
redis-cli -h redis.myapp.localhost -p 6379 --tls \
  --sni redis.myapp.localhost --cacert "$(mkcert -CAROOT)/rootCA.pem" PING
```

Plain `sslmode=require` (without `sslnegotiation=direct`) times out: libpq does a
plaintext `SSLRequest` preamble first, so Traefik never sees the SNI. devrouter
advertises ALPN `postgresql` automatically (libpq direct-SSL mandates it).

## 5. Verify / tear down

```bash
devrouter repo devcontainer verify --json
devrouter repo devcontainer verify --live --yes --json # after the devcontainer is running; registers/probes routes
devrouter ls
devrouter app rm app --keep-config
devrouter app rm db --keep-config
```

## Notes

- Nothing is published on the host — the `*.localhost` hosts are the only access
  path, but that is what makes multiple devcontainers coexist collision-free.
- App URLs that must match the routed host (auth callbacks, `NEXTAUTH_URL`, OIDC
  issuers) point at `https://myapp.localhost` / `https://oidc.myapp.localhost`.
  For an OIDC issuer the app also fetches **server-side**, map the host to the
  host gateway (`extra_hosts: ['oidc.myapp.localhost:host-gateway']`) and trust
  the mkcert CA in-container (`NODE_EXTRA_CA_CERTS`) — never disable TLS
  verification.
- Migrating from the older host-port onboard (single `upstream: 127.0.0.1:<port>`
  + published ports): see the `devcontainer-onboarding` skill's "Migrating an
  existing host-port onboard to devnet" section.
