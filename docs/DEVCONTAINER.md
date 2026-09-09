# Fronting a devcontainer with devrouter

The preferred Devrouter model. The **devcontainer owns the
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

We recommend **DevPod** or **Devsy** for orchestrating the devcontainer lifecycle locally; both are client-only, open-source tools that execute entirely locally on Docker, mount and sync workspace files in the background, and do not force a specific IDE. Runtime selection is path-aware: `DEVROUTER_WORKSPACE_RUNTIME=devpod|devsy` forces one runtime, an exact-path registry owner wins next (mixed fleets keep their checkouts separated), then the machine preference from `devrouter setup --yes --workspace-runtime <runtime>`, then installed-CLI auto-detection. For Devsy workspaces, `devrouter setup --yes --devsy-inactivity-timeout <duration>` (for example `30m`) configures idle shutdown.

Devsy's desktop app and CLI are complementary: the app manages and displays
workspaces, while devrouter uses the CLI for deterministic automation. They
share one registry, so a workspace started with `devrouter ensure` is visible
in the app. On macOS, the app-bundled CLI lives under
`/Applications/Devsy.app/Contents/Resources/bin`; keep one Devsy version on
`PATH` and leave the app running when using that bundled CLI so its local
daemon handles workspace operations.

Devrouter-launched Devsy workspaces also require one verified Linux agent.
Prepare it once with `devrouter setup --yes --workspace-runtime devsy`.
Devrouter stores the supported pinned asset under its own machine cache and
passes the verified path only to the CLI child that starts the workspace. It
uses direct HTTPS first and can use an authenticated GitHub CLI as a transport
fallback for the same pinned asset; both paths enforce the same size and digest.
Devrouter does not write Devsy's private cache or alter the desktop app environment. An
explicit `DEVSY_AGENT_BINARY` remains authoritative, but must match a pinned
official asset exactly. `devrouter doctor` checks readiness without network
access; a missing, stale, or invalid source stops `ensure` before the Devsy
mutation queue or provider is touched.

> Use the current devrouter release. The end-to-end onboarding
> playbook + reference templates + gotchas live in the
> `devcontainer-onboarding` skill (`.agents/skills/devcontainer-onboarding/`).

Use the CLI discovery, writer, and static-evidence sequence in the
[repository onboarding guide](./REPO_ONBOARDING.md#preferred-managed-devcontainer-path)
before applying this contract.

Before provider startup, a managed adapter paired with `postCreateCommand`
requires `waitFor` exactly `postCreateCommand` or `postStartCommand`. Devrouter
rejects missing, earlier, malformed, or unsupported lifecycle ordering before
provider mutation. Selective managed configuration preserves lifecycle fields
and changes only `runServices`.

## Application readiness contracts

An HTTP proxy app can declare the application response that `ensure` must verify:

```yaml
readiness:
  path: /api/health
  statuses: [200]
  contentType: application/json
```

Without this declaration, the existing root probe checks route liveness and accepts
responses below 500. It does not prove a database, authenticated journey or other
application capability. Profile `readiness` selects which apps are checked; each
app's `readiness` object defines its expected response.

The path stays on the app's configured host. Redirects are never followed. Paths
cannot contain query strings, fragments, percent escapes, backslashes or dot
segments. Omitted statuses default to `[200]`; explicit unique lists accept 2xx
or 4xx responses, never redirects. An expected 401 can verify an authentication
boundary. Media types match case-insensitively without parameters, so JSON with
a charset matches `application/json`; other JSON-derived types do not.

For declared contracts, `ensure --json` includes `applicationReadiness` with
per-app evidence and timestamps. An application failure exits nonzero but keeps
the reconciled infrastructure, processes and routes available for debugging.
It does not trigger speculative provider recreation or profile rollback. The
operation has a known failure result, so subsequent `exec` remains available
after worker drainage. Managed runtime status describes infrastructure; it is
not a substitute for fresh application proof. Live verification uses the same
declared HTTP contract. Neither check replaces a consumer-owned functional test.

## Interrupted lifecycle commands

`ensure`, `exec`, and `stop` coordinate through a private per-checkout operation
record under `~/.config/devrouter/reliability`. Each invocation owns a packaged
worker that retains the workspace lock through provider work. Explicit `stop`
records stopped intent before waiting and prevents earlier workers from claiming
new mutations or restoring routes. Completion requires positive workload and
route cessation evidence as well as drainage of earlier workers.

When another positively identified lifecycle worker is active on the same checkout,
`exec` waits asynchronously for up to thirty minutes and reports progress on stderr.
Commands remain serial; waiting does not promise FIFO ordering or a persistent
queue. The waiting invocation keeps its request identity and refreshes runtime
proof before admission. Cancellation or timeout before admission leaves the running
command untouched. An intervening stop or other lifecycle fence change cancels
admission, even if the environment subsequently resumes. Uncertain completion or
unavailable worker identity does not grant permission to launch another command.

A proven application exit code remains the CLI exit code. A lost completion is
reported as unknown. A new ensure reconciles an interrupted ensure after positive
worker drainage while retaining its unknown historical result. Unknown arbitrary
exec is never replayed; explicit stop reconciles that command uncertainty.
For a manual Devsy workspace with running intent, a new `exec` can also proceed
once an interrupted ensure has fully drained. This recovery supports a local Docker
provider using the plain `docker` command; Apple and custom provider commands remain
unsupported. Devrouter proves the exact running
container and provider identity, then revalidates them before launching the command.
This preserves tooling access despite configuration drift without claiming startup
succeeded or changing retained configuration, managed state, or routes. Missing
identity proof or an earlier uncertain exec still prevents command dispatch.
If stop cannot prove cessation, preserve the operation record and generated
configuration and investigate the reported provider or worker evidence. Deleting
bookkeeping cannot prove that earlier work stopped. Corrupt or incompatible
records fail closed. Operation history is bounded and refuses new dispatch when
full; it is not silently discarded.

These commands provide manual lifecycle coordination. They do not enroll the
machine in resource admission, prevent OOM, or enable capacity-managed parking/recovery.

## Foreground consumer sessions

`devrouter controller run` owns a private local socket and durable session snapshot
under `~/.config/devrouter/controller`. Start it explicitly in a separate terminal.
Clients never start an observer implicitly. Session enrollment requires an existing
managed linked checkout with consistent Git ownership and provider registration.

```sh
devrouter controller observe /absolute/path/to/worktree \
  --session engineering --profile full --require runtime --json
devrouter controller status --session engineering --json
```

Keep the returned `store`, `epoch`, and `generation` with the session ID. Supply
all four to `controller renew`, `controller release`, and `controller watch`.
Renew every ten seconds; the lease lasts thirty seconds. Watching and status reads
do not renew it. `app:<name>` requirements need an application in the selected
profile with an explicit HTTP readiness contract.

Treat `UNKNOWN`, expired evidence, disconnection, and lost event continuity as
unverified readiness. Reacquire after observer restart; old bindings cannot renew
or release a replacement session. Watch reconnection uses `--after <epoch>:<sequence>`
and `--after-store <store>` for bounded replay. A gap requires accepting the current
snapshot instead of relying on retained events as fresh readiness evidence.

Releasing a session, letting its lease expire, or stopping the foreground observer
leaves application runtimes and data intact. Continue using explicit `ensure`,
`exec`, and `stop` for lifecycle actions. Consumer sessions grant no automatic
recovery, capacity admission, or agent-command replay authority.

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
  version: <semver>
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

For managed `devrouter ensure`, every HTTP and TCP upstream must begin with the
resolved checkout alias prefix. Use `${WORKSPACE}-<service>:<port>` with matching
`${WORKSPACE:-<project>}-<service>` Compose aliases. Generic route-only
`devrouter app run` remains available for intentionally external upstreams.

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

The managed scaffold keeps Devrouter packages and helpers out of the app image.
After proving the exact running container, `devrouter ensure` delivers its matching
helper to a runtime-only path and invokes the repository-owned `post-start.sh`:

```bash
"$DEVROUTER_PROCESS_HELPER" ensure \
  --name app \
  --match 'pnpm(\.cjs)? .*dev' \
  --log /tmp/devrouter-app.log \
  -- bash -lc 'pnpm dev'
```

Devrouter captures the adapter once, hashes those exact bytes, delivers the same
snapshot, and executes it in the validated container. The delivered helper
serializes concurrent starts, records and verifies the session leader, reuses
only the same command, workspace, adapter, and explicitly allowlisted environment
identity, replaces only its owned process group, and refuses unknown matching
processes. It requires Linux `/proc`, `procps`, and `util-linux`; the generated
image includes them. Set `DEVROUTER_PROCESS_FINGERPRINT_ENV` to a comma-separated
list only when non-secret environment values such as a public application origin
affect reuse. Secret-like names are rejected and raw values are never written to
state. Use `--fingerprint <value>` only for a complete caller-owned identity that
should replace the default fingerprint.

For synchronous dependency preparation, pass `--prepare-command 'command'` to
the helper's `ensure` action. An unchanged owned runtime skips preparation.
A changed runtime stops its owned group first, checks for foreign matches,
then prepares under the same lock before launch. Preparation failures prevent
launch. The exact preparation command participates in the default fingerprint;
callers using `--fingerprint` must include preparation changes themselves.
Preparation must stay in its foreground process group without daemonizing or
detaching. After a successful command exit, the helper allows up to two seconds
for remaining children to finish naturally before rejecting persistent children.
Cancellation terminates that group before releasing the lock and
reaps the direct child; container init reaps orphan zombies.

Application environment setup and the exact command remain repository-owned.
HTTP readiness remains host-side in `ensure`, so applications do not
need a second route-health policy.

## Select only the capabilities a task needs

Repositories that generate Compose inputs on the host can declare
`managedRuntime.devcontainer.prepareCommand` as a literal argument array, for
example `["node", ".devcontainer/prepare.mjs"]`. Each `ensure` invokes it once
from the checkout root, under lifecycle serialization, before inspecting Compose.
The command has a sixty-second deadline, runs without implicit shell expansion,
and must finish in the foreground. Its output is suppressed. Failure or a change
to `.devrouter.yml` prevents startup; the changed file is preserved for correction.
Diagnostics never invoke the command. Generated-input preparation does not by
itself establish that changed mounts were applied to an existing container.

The source `devcontainer.json` remains the native, full environment. A normal
Dev Container client uses its declared `runServices` and can start every
service the repository provides. The managed `devrouter ensure` path can use a
profile to select only the apps, optional Compose services, and repository-owned
processes needed for one task.

Register optional resources explicitly in `.devrouter.yml`:

```yaml
managedRuntime:
  devcontainer:
    baseServices: [postgres]
    profileServices: [litellm, mcp-server]
  processes: [web, local-mcp]

profiles:
  web:
    apps: [web]
    processes: [web]
  ai:
    apps: [web]
    devcontainerServices: [litellm]
    processes: [web]
  mcp:
    devcontainerServices: [mcp-server]
    processes: [local-mcp]
  full:
    apps: ['*']
    devcontainerServices: ['*']
    processes: ['*']
    default: true
```

`baseServices` stay with the primary app service for every managed profile.
`profileServices` and `processes` are registries, not an instruction to start
everything. A managed profile selects each dimension independently, so a
route-free capability profile such as `mcp` may omit `apps`. An omitted optional
dimension selects nothing; use the `*` wildcard or the `full` profile when the
whole registered set is required. An app-only profile therefore does not start
LiteLLM, MCP, MailHog, or another optional capability unless it names that
resource explicitly.

Select a profile with the managed lifecycle command:

```bash
devrouter ensure . --profile ai --json
devrouter ensure . --profile mcp --json
devrouter status --repo . --json
devrouter doctor --repo . --json
```

The status and doctor output reports desired and active apps, services, and
processes plus values-free drift. `devrouter ensure` writes an ignored,
Devrouter-owned `.devcontainer/devcontainer.devrouter.json` beside the source
configuration and passes it to DevPod before startup. The generated file keeps
the source configuration's relative paths and changes only the selected
`runServices`; never commit or hand-edit it. The primary service and every
declared base service remain selected. DevPod may append its own generated
container-features Compose file to the runtime labels; devrouter accepts that
specific provider-owned file while rejecting unrelated Compose overlays.

Switching profiles in an existing workspace is warm and non-destructive. The
same DevPod and volumes are retained, newly selected services start without
`--recreate` or `down`, and dropped services or processes stop only after exact
ownership is proved. `postCreateCommand` does not run again. Routes publish
last, after service health and process state are proved. Application readiness
then checks the published routes. A declared application contract failure retains
the reconciled infrastructure and routes. If an infrastructure transition fails,
the previous route set and successful state are kept
when possible; otherwise status reports the degraded transition. The next ensure
attempt repairs retained resources before applying another profile change.

After exact inspection proves the runtime stopped and its routes absent, status
reports `stopped` even if the last transition degraded. The retained drift and
transition phase describe that incident. Unavailable inspection or conflicting
ownership never counts as stopped proof.

A proven command result or a failure that proves the command never launched does
not require stopping the environment before the next command. Devrouter retains
that result atomically and waits for the old worker to drain. Unknown arbitrary
command completion still requires explicit reconciliation and is never replayed.

Ordinary `devrouter ensure .` repairs a retained degraded runtime automatically.
For the recorded profile it repairs retained resources and proves readiness.
For a different requested profile it proves the retained ownership baseline, then
starts the requested resources directly. A failing process that the new profile
drops does not have to start first. Failed transitions retain degraded state and
do not replay the broken baseline adapter. No separate repair command is needed. The compatibility
`--repair` option limits the invocation to the recorded-profile repair path.

If a degraded runtime remains after `managedRuntime` is removed from the repository
configuration, restore that configuration before recovery. Devrouter retains the
runtime and its generated configuration until it can prove a safe transition.

Repair requires a valid degraded managed-runtime record. When no `--profile` is
given, it uses that record's canonical profile. Before any provider or process
mutation, it checks the exact retained baseline: the provider registration and
workspace, Compose project, retained primary and required containers, selected
app/service/process sets, source and effective Dev Container hashes, generated
file ownership and content, and retained container configuration. Missing,
foreign, corrupt, legacy, ready, or drifted baselines are rejected.

Repair reruns the current repository adapter against the retained runtime. It
may replace only already-owned process groups whose fingerprints changed and
may start retained stopped containers by their exact Docker IDs. For a stopped
primary, every container in its Compose project must be explicitly stopped and
no checkout routes may remain. Startup runs the existing container entrypoint;
provider bootstrap, creation, recreation, and resource adoption are skipped.

If replay fails, owned resources may remain running and the runtime remains
degraded. Repair restores previous routes when publication fails, but does not rerun
the failed adapter during rollback. It uses existing routing infrastructure and
never restarts the shared router. Infrastructure ready state requires retained
resource and route-generation proof. Declared application failures remain separate
in the ensure result and do not invalidate that infrastructure state.
When the exact old Compose project is positively proven absent, ordinary ensure
uses the existing startup recovery path. Unavailable inspection is never absence.

## 5. Bring up routing

For a managed Devsy workspace prepared through a local Unix Docker endpoint
with a retained stop baseline, `devrouter stop .`
revalidates the recorded provider, Docker daemon and complete container population
before stopping the exact container IDs and removing routes. The baseline is
recorded after infrastructure preparation, before application readiness, so an
application failure does not prevent shutdown. Repository and generated
configuration may change or disappear without invalidating this stop path.
Containers and volumes remain intact. Missing, replaced, foreign or unreadable
members prevent successful stop proof; stopped provider status alone is insufficient.

Startup requires this complete ownership proof before launching the selected
application and publishing its routes. Unexpected project members, including
leftover one-off containers or removed services, leave startup unverified; they
are never silently adopted or deleted. The error identifies the failed startup
proof. Recognized non-Unix transports retain the legacy capability path; unknown
ownership on a supported endpoint does not trigger that fallback.

For a retained workspace without a stop baseline, stop uses its configuration-based
ownership checks. If the primary container is already
stopped, it skips Devsy's stop command and stops only the captured running
service IDs after fresh ownership and configuration checks. Containers and
volumes remain intact. Missing, replaced, foreign or unreadable members prevent
cleanup; stopped provider status alone is insufficient.

On that legacy path, unapplied Compose service edits do not require matching live service hashes to
stop retained containers. Stop still verifies the recorded profile, Compose file
identity, complete service population, exact workspace mount and stable container
identities. Startup retains its configuration checks before reusing containers.

A failing provider stop remains an error even when independently verified
residual shutdown succeeds. Routes remain intact on that error; a later stop
can finish route cleanup after full stopped proof. Do not remove the retained
runtime record to bypass an ownership or configuration mismatch.
A present invalid stop baseline is an error and never falls back to legacy checks.

Order matters — `devnet` is `external`, so it must exist before the container
starts:

```bash
devrouter setup --yes --workspace-runtime devsy # when Devsy owns this checkout
devrouter doctor --json
devrouter ensure .
```

Do not replace these commands with raw DevPod or Devsy `up`/`stop`/`delete`
calls. Raw provider calls bypass devrouter's machine-wide mutation lock and exact
ID/path postcondition checks. Use `devrouter stop . --delete` for explicit
exact-owner workspace runtime cleanup while preserving the checkout.

The same command handles a linked worktree. It starts or attaches the exact-path
workspace runtime, recreates one stale runtime once,
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
# Explicit full workspace runtime cleanup while preserving this Git checkout:
devrouter stop . --delete
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
