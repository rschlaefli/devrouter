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

We recommend **DevPod** for orchestrating the devcontainer lifecycle locally because it is a client-only, open-source tool that executes entirely locally on Docker. It mounts and syncs workspace files in the background without forcing developers into a specific IDE or requiring proprietary extensions.

> Use the current devrouter release. The end-to-end onboarding
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
  version: 0.0.32
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

## 3. Preserve linked-worktree Git metadata

Keep a no-op default overlay for primary-checkout startup and a committed
`.devcontainer/docker-compose.devrouter.yml` for linked worktrees:

```yaml
services:
  app:
    environment:
      WORKSPACE: ${WORKSPACE:-}
      DEVROUTER_WORKSPACE: ${DEVROUTER_WORKSPACE:-}
    volumes:
      - type: bind
        source: ${DEVROUTER_GIT_COMMON_DIR}
        target: ${DEVROUTER_GIT_COMMON_DIR}
```

In `devcontainer.json`, list the base compose file followed by
`${localEnv:DEVCONTAINER_COMPOSE_OVERLAY:docker-compose.default.yml}`. A linked
worktree's `.git` file points into the host repository's common Git directory;
`ensure` supplies that absolute path and the two identity variables,
then verifies them in the container.

## 4. Start one owned application process

The managed scaffold extracts only `devrouter-process` from the exact Devrouter
package tarball into the app image; it does not install the CLI dependency tree.
Its `post-start.sh` delegates background-process lifecycle to that packaged helper:

```bash
devrouter-process ensure \
  --name app \
  --match 'pnpm(\.cjs)? .*dev' \
  --log /tmp/devrouter-app.log \
  -- bash -lc 'pnpm dev'
```

The helper serializes concurrent starts, records and verifies the session leader,
reuses only the same command and workspace identity, replaces only its owned
process group, and refuses unknown matching processes. It requires Linux `/proc`,
`procps`, and `util-linux`; the generated image includes them. Use
`--fingerprint <value>` only when the application has additional runtime identity
that is not derived from its command, `WORKSPACE`, or `DEVROUTER_WORKSPACE`.

Application environment setup and the exact command remain repository-owned.
HTTP readiness remains host-side in `ensure`, so applications do not
need a second route-health policy.

## 5. Bring up routing

Order matters — `devnet` is `external`, so it must exist before the container
starts:

```bash
devrouter setup --yes
devrouter doctor --json
devrouter ensure .
```

The same normal command handles a linked worktree:

```bash
devrouter ensure .
```

It starts or attaches the exact-path DevPod, recreates one stale runtime once,
and proves the overlay, Git mount, environment, aliases, health, Git access,
HTTP route reachability, and unique running TCP upstream ownership before
reporting ready.

`verify --live` remains a compatibility check in this release, not a startup
command. For a manual route-only path, run `devrouter app run <name> --yes`
for each proxy app instead. A proxy app route starts no process. The container
owns start and stop. Routes persist until `devrouter app rm <name> --keep-config`.

Open `https://myapp.localhost`.

## 6. Connecting to a TCP route (Postgres / Redis)

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

## 7. Verify / tear down

```bash
devrouter repo devcontainer verify --json
devrouter ensure . --json
devrouter exec . -- pnpm seed
devrouter ls
devrouter stop .
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
