# devrouter — `runtime: proxy` (upstream-only) mode

Status: **planned**. Branch: `feat/proxy-runtime`. Target release: **0.0.20**.
Last updated: 2026-06-13.

## Why

Consumers are moving local dev to the **devcontainer** standard (run via DevPod /
VS Code / `@devcontainers/cli`). The container now owns the *environment*:
toolchain, datastores, auth mock, app process, seed, run. devrouter's remaining
unique value is the **routing/TLS layer**: stable `*.localhost` HTTPS on a shared
`:443`, TCP/SNI on `:5432`, mkcert TLS.

But devrouter has no "just route to an already-running port" mode:

- `runtime: host` forces `hostRun` — devrouter *starts the process*.
- `runtime: docker` makes devrouter *own a compose service* — conflicts with
  DevPod owning the compose project.

Both fight a devcontainer. We need a third mode that registers a Traefik route
to an **externally-managed** port and does nothing else.

## Goal

Add `runtime: proxy`: an HTTP app that registers `Host(host) → http://<upstream>`
and has **no** lifecycle, env injection, `hostRun`, compose ownership, or
dependencies. `dev app run <proxy>` writes the route once and returns; the route
persists until `dev app rm`. Makes devrouter **compose-runner-agnostic** — it
sits in front of DevPod, raw `docker compose`, or a host process equally.

Target `.devrouter.yml`:

```yaml
apps:
  - name: app
    host: derivatives-game.localhost
    protocol: http
    runtime: proxy
    upstream: 127.0.0.1:3000   # already-running port (e.g. devcontainer's published app)
```

## Design

- **Reuse the host-routes pipeline.** Route registration is already fully
  decoupled from process lifecycle: `upsertHostRoute()` writes
  `host-routes-state.json` + re-renders the Traefik dynamic file
  (`host-routes.yml`, watched live). A proxy route is just one `upsertHostRoute`
  call with no process behind it. (`src/core/host-routes.ts`)
- **Backend URL + loopback rewrite.** Traefik runs *inside* Docker, so a
  user-facing `127.0.0.1:3000` / `localhost:3000` upstream must resolve to
  `host.docker.internal:3000` for Traefik to reach the host. Rewrite loopback
  hosts at route-write time; pass any other host through verbatim (advanced:
  point at a devnet container). The current host-route backend is hardcoded
  `http://host.docker.internal:${route.port}` (`host-routes.ts:64`) — generalize
  to `http://${route.upstreamHost ?? "host.docker.internal"}:${route.port}`.
- **State shape.** `HostRouteState` already carries `port`. Add `mode: "proxy"`
  and an optional `upstreamHost`. Store the parsed port in `port`, the rewritten
  host in `upstreamHost`; keep the user's raw `upstream` string verbatim in
  `.devrouter.yml` only.
- **No PID.** Proxy routes have no process. This is the one real landmine:
  staleness/eviction and status display both key off `isPidRunning(pid)`.
  `mode === "proxy"` must short-circuit both (see Complications).
- **No dependencies.** Forbid `dependencies` on proxy apps at parse time
  (keeps `startAppDependencies()` and its non-docker-dep guard out of scope).

## Slices

Each slice is independently committable. File refs are current `feat/proxy-runtime`.

### P1 — Types (`src/types.ts`)
- Add `DevrouterProxyHttpApp = DevrouterRoutedAppBase & { protocol: "http"; runtime: "proxy"; upstream: string }`.
- Add it to `DevrouterRoutedApp` (177) and thus `DevrouterApp` (179).
- `AppAddOptions` (181): widen `runtime` to `"host" | "docker" | "proxy"`, add `upstream?: string`.
- `HostRouteState` (81–93): `mode: "run" | "attach" | "proxy"`, add `upstreamHost?: string`.
- `RunAppResult.mode` (app-run.ts ~45): add `"proxy"`.
- *Acceptance:* `pnpm typecheck` clean after downstream slices.

### P2 — Config parse + validate (`src/core/repo-config.ts`)
- Add `"upstream"` to the `ensureAllowedKeys` list (~210).
- Add a `runtime === "proxy"` branch in `parseApp` (before the fallthrough ~326):
  require `protocol === "http"`, require non-empty `upstream` matching `host:port`
  (port 1–65535), **forbid `hostRun`/`docker`/`dependencies`**, return a
  `DevrouterProxyHttpApp`.
- Add a `proxy` branch in `buildAppFromOptions` (~545, the `dev app add` path):
  require `--upstream`, forbid `--service`/`--port`/`--command`.
- *Acceptance:* valid proxy yaml parses; missing/invalid `upstream`, wrong
  protocol, and `dependencies` present all throw clear errors.

### P3 — Route backend URL (`src/core/host-routes.ts`)
- `UpsertHostRouteInput`: `mode: "run" | "attach" | "proxy"`, add `upstreamHost?: string`.
- `upsertHostRoute` (129): persist `upstreamHost`.
- `writeHostRoutesDynamicFile` (45): backend url →
  `http://${route.upstreamHost ?? "host.docker.internal"}:${route.port}`.
- `listHostRoutes` status (211): `route.mode === "proxy" ? "running" : (isPidRunning(route.pid) ? "running" : "stopped")`.
- Add a small `parseUpstream(upstream)` helper (host+port split, loopback→`host.docker.internal` rewrite, validation) — colocate here or in repo-config; used by the run flow.
- *Acceptance:* a proxy route entry renders a correct backend url; loopback rewritten.

### P4 — Eviction guard (`src/core/concurrency.ts`) — **critical**
- `evictIfStale` (50): `if (route.mode === "proxy") return false;` **before** the
  PID check. Without this, proxy routes are evicted on every `dev doctor` and
  every `assertAppNotRunning` call (silent route deletion).
- *Acceptance:* `evictStaleHostRoutes()` never removes a proxy route;
  `assertAppNotRunning` does not treat a live proxy route as stale.

### P5 — Run flow (`src/core/app-run.ts`)
- In `runConfiguredApp` (704): add a `deps.app.runtime === "proxy"` branch that:
  - calls `assertAppNotRunning` (explicitly — the guard lives in `runHostApp`, which proxy bypasses) for the hostname-conflict check (idempotent re-run of the same proxy app must not throw → `evictIfStale` returns false for proxy, so the existing-route path throws `AppAlreadyRunningError`; handle by treating a same-id proxy route as a no-op upsert rather than a conflict).
  - parses `upstream`, calls `upsertHostRoute({ mode: "proxy", port, upstreamHost, host, name, repoPath })`.
  - prints the route URL + upstream and returns `{ mode: "proxy" }` immediately (mirror the docker-TCP one-liner return).
  - does **not** call the process loop and does **not** register signal cleanup (route persists).
- Skip `startAppDependencies()` for proxy (no deps allowed).
- *Acceptance:* `dev app run <proxy>` writes the route, spawns no process, returns 0; re-running is idempotent (no false "already running").

### P6 — CLI (`src/cli.ts`)
- `dev app add`: `--runtime` description → `host, docker, or proxy`; add `--upstream <host:port>`; widen options type.
- `dev app run` command handler: print `... is running in proxy mode.` (RunAppResult.mode).
- *Acceptance:* `dev app add --runtime proxy --host x.localhost --upstream 127.0.0.1:3000` writes valid config.

### P7 — Output/status (`src/core/output.ts`)
- `printConfigApps` (120): add a proxy branch showing `upstream` as the target (parallel to host's command / docker's service:port).
- `printHostRouteState` (82): show `proxy` mode as `active` (not `stopped`) since there's no pid.
- *Acceptance:* `dev app ls` and `dev ls` show proxy apps/routes with a sensible target + active status.

### P8 — Doctor (`src/core/doctor.ts`)
- `routes.host-state` (653) and `routes.stale-host-routes` (665): exclude
  `route.mode === "proxy"` from PID-based staleness (P4 already protects eviction;
  ensure the *report* doesn't flag proxy routes as stale either).
- Confirm runtime-filtered repo checks (`compose-files`, `host-cwd`,
  `host-command-env-precedence`, `postgres-credentials`) naturally exclude proxy
  (they filter on `=== "host"` / `=== "docker"`). TLS host-coverage *should*
  include proxy (it has a host) — leave as-is.
- *Acceptance:* `dev doctor` reports a proxy-only repo as clean; no stale-route
  false positives.

### P9 — AI prompt + skill (`src/core/ai-prompt.ts`, `.factory/skills/devrouter/SKILL.md`)
- Document the `proxy` runtime + `upstream` field in the canonical schema/prompt
  and skill. Required for `ai-prompt.test.ts` consistency.

## Tests (vitest, `src/core/__tests__/`)
- `repo-config.test.ts`: add `VALID_PROXY_APP` fixture; assert parse
  (`runtime: "proxy"`, `upstream`); rejection tests (missing upstream, bad
  host:port, `protocol: tcp`, `dependencies` present, unknown key).
- `concurrency.test.ts`: a `mode: "proxy"` route survives `evictStaleHostRoutes()`
  and is not treated as stale by `assertAppNotRunning`.
- `app-run-exec.test.ts`: `runConfiguredApp` proxy branch calls `upsertHostRoute`
  once, spawns no process, returns `mode: "proxy"`; second run is idempotent.
- `routes.test.ts` / host-routes: a proxy state entry renders the rewritten
  backend url and `running` status.
- `ai-prompt.test.ts`: passes with proxy docs added.

## Release 0.0.20 (per AGENTS.md checklist)
1. Commit implementation slices first (P1–P9 + tests), separate from release commit.
2. `package.json` version → `0.0.20`.
3. `demo/.devrouter.yml` `devrouter.version` → `0.0.20`.
4. `CHANGELOG.md`: new `[0.0.20]` section between `[Unreleased]` and `[0.0.19]`,
   with `### Agent Adaptation Prompt` → `./upgrade-prompts/0.0.20.md`.
5. `upgrade-prompts/0.0.20.md`: summary (new proxy runtime), task (bump version;
   no migration required for existing configs; optional: convert host/docker app
   to proxy when fronting a devcontainer), validation, report template.
6. Update product docs (`README.md`, `docs/GETTING_STARTED.md`,
   `docs/REPO_ONBOARDING.md`, `docs/PLAN.md`, `demo/README.md`, AGENTS.md "Current
   product model" + repo map) to add the proxy runtime.
7. Validation: `pnpm check:docs-policy`, `pnpm test`, `pnpm typecheck`,
   `pnpm build`, `dev doctor --repo ./demo`. (`demo:smoke` exercises real Docker;
   run if available.)
8. Single release commit: `Release 0.0.20 -- proxy runtime mode`.

Optional: add a proxy app to `demo/.devrouter.yml` (or a comment) so the demo
documents the mode without needing an external port.

## Complications & decisions
- **PID-based eviction (P4)** is the one true trap — proxy routes have no pid and
  would be silently deleted. Guarded by an early `mode === "proxy"` return.
- **Idempotent re-run (P5).** `assertAppNotRunning` throws `AppAlreadyRunningError`
  for an existing same-id route, and `evictIfStale` won't clear a proxy route. So
  the proxy run branch must treat "my own proxy route already exists" as a no-op
  re-upsert, not a conflict. Hostname *conflict with a different app* still throws.
- **Deps forbidden** on proxy (parse-time) keeps `startAppDependencies` untouched.
- **Loopback rewrite** is required (Traefik-in-Docker); document it so
  `upstream: localhost:3000` "just works".
- **Cleanup.** Proxy routes persist intentionally; `dev app rm` already removes by
  name. Document that `dev app run` exit does **not** tear down a proxy route.

## Sequence
P1 → P2 → P3 → P4 → P5 (core works end-to-end here) → P6/P7/P8 (surface) → P9 (docs/prompt) → tests alongside each → release.

## Out of scope (later)
- ~~TCP proxy upstreams (only HTTP for now).~~ **Done in 0.0.21** — `runtime: proxy` + `protocol: tcp` SNI-routes a DB in an externally-managed container (e.g. devnet Postgres) via a file-provider TCP router; requires TLS + libpq direct-SSL + an ALPN `postgresql` TLSOption.
- Auto-detecting the devcontainer's published port.
- A `dev app route`-style command that registers a route without an app entry.
