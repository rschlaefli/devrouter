# Repository onboarding

Adapt an existing repository to Devrouter's unified `.devrouter.yml` model.
Complete [machine setup and a first route](./GETTING_STARTED.md) before using
this guide.

## Scope

Devrouter has no central repository registry and does not manage Kubernetes.
`.devrouter.yml` is the only supported per-repository configuration.

## Inspect before editing

Start with read-only evidence:

```bash
devrouter setup --yes --json
devrouter doctor --repo /absolute/path/to/repository --json
devrouter repo inspect --repo /absolute/path/to/repository --json
```

Inspection reports package-manager metadata, scripts, likely ports, Compose
services, environment-variable names but not values, existing Devrouter and
devcontainer files, and agent guidance. Use those facts to choose one lifecycle
owner for each application.

| Repository shape | Recommended path |
| --- | --- |
| Self-contained or container-ready | Use the [managed devcontainer contract](./DEVCONTAINER.md) and `runtime: proxy`. |
| Host development command | Use `runtime: host`; Devrouter starts the command and detects its port. |
| Existing Compose application | Use `runtime: docker`; Devrouter starts the selected service. |
| Externally managed listener | Use `runtime: proxy`; Devrouter publishes only the declared upstream. |

## Preferred managed devcontainer path

The first generated scaffold is deliberately narrow: Node.js, pnpm, and
PostgreSQL. Unsupported package managers stop with
`repo.devcontainer.package-manager-unsupported` instead of writing a partial
integration.

```bash
devrouter repo devcontainer write --repo /absolute/path/to/repository --dry-run --json
devrouter repo devcontainer write --repo /absolute/path/to/repository --yes
devrouter repo devcontainer verify --repo /absolute/path/to/repository --json
devrouter ensure /absolute/path/to/repository --json
devrouter exec /absolute/path/to/repository -- pnpm seed
```

The writer changes only missing or marked Devrouter-managed targets. A custom
`.devcontainer/` or `.devrouter.yml` produces a conflict for manual review.
Static `verify --json` is PR evidence; it is not startup. `ensure` starts or
attaches the exact checkout, delivers the matching runtime helper, invokes the
repository-owned adapter, proves readiness, and publishes routes. The mutating
`verify --live --yes` form is only a compatibility check after startup.

Consumer images contain no Devrouter package or helper. See
[Fronting a devcontainer](./DEVCONTAINER.md) for the canonical Compose overlay,
network aliases, managed process contract, TCP clients, and teardown.

## Configure `.devrouter.yml`

Initialize metadata before adding applications:

```bash
devrouter repo init
```

The file uses schema version 1 and records the applied CLI version for
`devrouter -V` and `devrouter upgrade`:

```yaml
version: 1
devrouter:
  version: <semver>
project:
  name: my-repository
apps: []
```

### Proxy application

```yaml
- name: app
  host: app.localhost
  protocol: http
  runtime: proxy
  upstream: ${WORKSPACE}-app:3000
```

A proxy application starts no process or dependency. Re-running it is an
idempotent route upsert; `devrouter app rm <name> --keep-config` releases the
live route without editing the config. Loopback upstreams are rewritten to
`host.docker.internal`, but a stable `devnet` alias avoids host-port collisions.

### Host application

```yaml
- name: web
  host: web.localhost
  protocol: http
  runtime: host
  hostRun:
    command: pnpm dev
    cwd: .
    portTimeout: 180
  dependencies:
    - app: db
```

Devrouter injects `PORT=<free-port>`, `HOST=0.0.0.0`, and
`HOSTNAME=0.0.0.0`. It waits 120 seconds by default for a listener; set
`portTimeout` only when the real application needs longer. Host-runtime
dependencies are not auto-started and must be managed separately.

### Routed Docker service and dependency

```yaml
- name: db
  host: db.localhost
  protocol: tcp
  tcpProtocol: postgres
  runtime: docker
  docker:
    service: db
    internalPort: 5432
    composeFiles: [docker-compose.yml]

- name: redis
  kind: dependency
  runtime: docker
  docker:
    service: redis
    composeFiles: [docker-compose.yml]
```

Every Docker dependency must have a Compose healthcheck because Devrouter uses
`docker compose up --wait`. Do not publish Devrouter-owned ports (`80`, `443`,
or activated shared TCP ports) from consumer services. Prefer no host port
publishing at all.

`kind: dependency` entries have no host or route and cannot be direct
`app run`, `app exec`, or `open` targets. They start exactly as declared—without
Traefik labels, random port publishing, or injected environment—and only through
a routed application's dependency graph.

## Dependency environment and one-shot commands

For a host application, each TCP Docker dependency receives a random host port
and namespaced variables. The prefix is the uppercase dependency name with `-`
replaced by `_`.

| Protocol | Variables |
| --- | --- |
| All TCP dependencies | `<NAME>_HOST`, `<NAME>_PORT`, `<NAME>_URL` |
| PostgreSQL | Also `<NAME>_SHADOW_URL`; generated local credentials/databases are `prisma` and `shadow`. |
| Redis | URL form `redis://localhost:<port>`. |
| MariaDB/MySQL | URL form `mysql://root@localhost:<port>`. |

Map resolved values to application names on the dependency reference:

```yaml
dependencies:
  - app: db
    envMap:
      DATABASE_URL: DB_URL
      DIRECT_URL: DB_URL
      SHADOW_DATABASE_URL: DB_SHADOW_URL
```

Run migrations and seeds through the routed parent application:

```bash
devrouter app exec web --yes -- pnpm prisma migrate deploy
devrouter app exec web --yes -- pnpm seed
devrouter app exec web --yes -- printenv DB_URL DATABASE_URL DB_HOST DB_PORT
```

Exec starts missing Docker dependencies, preserves argv semantics by default,
and stops only dependencies it proved it started. If prior ownership cannot be
determined, it leaves the selected services running. Use `--shell` only for
shell expansion and pass exactly one command string after `--`.

### Secret-manager precedence

Use config-based wrapping when a secret manager would otherwise overwrite
Devrouter's resolved dependency values:

```yaml
secretManager:
  command: infisical run --env {env} --
  defaultEnv: dev
```

Select another environment with `app run --env <name>` or
`app exec --env <name>`. Devrouter inserts `env KEY=VALUE ...` after the
secret-manager boundary so resolved dependency variables and `envMap` aliases
win. The command must contain its trailing `--` boundary.

Do not assume precedence when overlapping database variables are set manually.
Avoid assignments before a wrapper's `run --` boundary, probe the effective
environment before migrations, and use `doctor` to detect
`repo.host-command-env-precedence` risks. Secret values remain native
environment state and must not be written into `.devrouter.yml`.

## TLS and TCP clients

Run `devrouter tls install` before TCP routing. Hostname multiplexing requires a
TLS ClientHello carrying SNI. PostgreSQL clients therefore need direct SSL
(libpq 17+ or an equivalent client):

```bash
psql "host=db.localhost port=5432 dbname=app user=app \
  sslmode=require sslnegotiation=direct"
```

Plain libpq `sslmode=require` sends a plaintext negotiation preamble first and
cannot select the hostname-specific Traefik route. `devrouter open <name>` prints
protocol-specific connection guidance. Multi-segment and workspace hosts receive
exact certificate SANs when `app run`, `app exec`, or `ensure` refreshes TLS.

## Parallel worktrees

Managed linked worktrees store one token in Git metadata and one durable owner
record under the repository's Git common directory. The token binds the exact
checkout, DevPod ID, route namespace, and `${WORKSPACE}` proxy alias. The primary
checkout remains non-namespaced; the committed `.devrouter.yml` is never
rewritten.

New worktrees default to the repository's ignored `trees/<workspace>` directory.
Devrouter refuses creation when `trees/` is not ignored; use `--path` only for an
intentional alternative.

```bash
devrouter workspace up feat/my-feature
devrouter ensure .
devrouter workspace ls
```

| Command | Result |
| --- | --- |
| `workspace stop` | Stop the exact DevPod and remove routes; keep checkout, owner record, and data. |
| `workspace down` | Delete runtime/routes; remove only a clean, unlocked worktree, then its record. |
| `workspace down --keep-worktree` | Delete runtime/routes; retain checkout and owner record. |
| `workspace gc` | Report missing-owner candidates; mutate nothing. |
| `workspace gc --yes` | Revalidate and delete only exact ledger-owned missing resources and their records; never remove Git worktrees or branches. |

`workspace ls` reports `present`, `missing`, `locked`, or `conflict`. Ambiguous
identity, foreign ownership, locks, and dirty destructive targets fail closed.
Git has no worktree-removal hook; after an out-of-band removal, inspect `ls`,
`doctor`, and dry-run `gc` before applying cleanup.

Do not use raw `devpod up`, `stop`, or `delete` for managed environments. Those
commands bypass Devrouter's machine-wide provider lock and exact ID/source
revalidation. Use `devrouter stop . --delete` to delete the exact runtime while
preserving the Git checkout.

## Agent and upgrade artifacts

```bash
devrouter repo agents
devrouter init --repo .
devrouter -V --repo .
devrouter upgrade --repo .
```

`repo agents` updates the owned Devrouter section in `AGENTS.md` and writes the
matching bundled skill. `init` prints a non-mutating onboarding prompt unless
explicit artifact-write flags are supplied. Upgrade commands compare installed
and repository metadata and read versioned adaptation prompts from
`upgrade-prompts/`.

## Verification and PR evidence

- `.devrouter.yml` parses and `devrouter app ls` shows the intended entries.
- `devrouter doctor --repo . --json` has no blocking finding or stale TLS coverage.
- `devrouter ls` shows the intended app and service identities; dependencies have no endpoint.
- Each HTTP route is exercised through its real `https://*.localhost` URL.
- Each TCP route is exercised with a direct-TLS/SNI-capable client.
- Managed devcontainers include static verify, `ensure --json`, route evidence, and exact-container `exec` evidence.
- Skipped live checks name the missing prerequisite and residual risk.

The [routing example](../examples/routing/README.md), [managed DevPod
example](../examples/devcontainer/README.md), and [workspace
example](../examples/workspace/README.md) provide runnable evidence paths.

## Troubleshooting

- Missing route: verify config, run the routed app or `ensure`, then inspect `devrouter ls`.
- Persistent database credential mismatch: reconcile the volume data; recreate volumes only when data deletion is safe and intentional.

For certificate, gateway, port, disk, timeout, and framework-origin failures,
use the [first-route troubleshooting guide](./GETTING_STARTED.md#if-the-first-route-fails).

Onboarding is complete when another engineer can reproduce setup, start the
intended lifecycle owner, reach every routed endpoint, run required one-shot
commands, and obtain clean diagnostics from the committed repository state.
