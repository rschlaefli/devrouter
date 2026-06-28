---
name: devcontainer-onboarding
description: Onboard a repo to a self-contained devcontainer (app + Postgres + Redis + local OIDC mock) fronted by devrouter over the shared `devnet` network with zero published host ports, so many devcontainers run at once. Use when adding a `.devcontainer/`, replacing manual local setup (Infisical/Auth0/host DBs) with a clone-and-run stack, migrating a repo to the devcontainer-first approach, or moving an older host-port onboard to devnet. Targets Node/pnpm/Prisma/Next + Auth0/OIDC apps; the pattern generalizes. Requires devrouter >= 0.0.21.
user-invocable: true
---

# devcontainer onboarding

Make a repo **clone-and-run**: `devpod up .` (or any devcontainer-spec tool — VS Code Dev Containers, `@devcontainers/cli`, Codespaces) brings up the full app with **zero manual steps and no external services**. devrouter fronts it over the shared external `devnet` network with **no published host ports**, so many devcontainers (app + DB + OIDC each) run simultaneously with zero collisions and the DBs are reachable from host tooling via `db.<app>.localhost`. Clean split: the **container owns the environment**, **devrouter owns the routing**.

The reference implementations this skill generalizes: `derivatives-game` (Next + Prisma + Postgres + Redis + OIDC mock), `careers`/jobeye (Next + Payload + Postgres), the gbl-uzh `demo-game` (Next + Postgres + OIDC mock, no Redis), and `klicker-uzh` (the **multi-app monorepo** case — one container runs `turbo dev` for 5 apps + Postgres + 3× Redis + MailHog + a Hatchet workflow engine; see the variant note below).

## When NOT to use

- The repo already has a working `.devcontainer/` → adjust it, don't re-scaffold.
- The app needs a real external service that can't be mocked/containerized locally → containerize what you can, document the rest; don't fake credentials for a live API.

## Multi-app monorepo variant

When the repo serves **several apps from one `turbo dev`** (api/auth/web/…), keep the single-`app`-container shape and route each `*.<proj>.localhost` host to that one container's internal port — do not scaffold a container per app (GOTCHAS #23). Extra checks beyond the single-app flow:

- **Shared session** across the apps: serve them all under `*.<proj>.localhost` so one auth cookie (domain `<proj>.localhost`) spans them; add the app's allowed-host override env (defaults usually only list prod hosts). SSR app→app calls stay intra-container via `http://localhost:<port>` (`*_URL_SSR`) — no cross-host TLS (#23).
- **Turbo strict-env**: audit `turbo.json` `globalEnv`/`passThroughEnv` against every var you inject via `env_file` — undeclared vars are stripped from the task and the app silently uses its defaults (#25).
- **Build-graph**: pre-build not just `packages/*` but any **app** whose dev script races (e.g. `rollup --watch` ∥ `nodemon`) so its `dist` exists before `turbo dev` (#26).
- **Dynamic service tokens** (Hatchet etc.): mint via a sidecar against the **same external DB** the engine server uses, and `exit 1` in post-create if the (boot-required) token never appears (#24).
- **Framework env**: client/SSR API URLs need the **full endpoint path** (`…/api/graphql`), and set `NODE_ENV=development` for dev-mode backend behavior (#27).

## Workflow

1. **Detect the stack** (read, don't assume):
   - Package manager + versions: `package.json` `packageManager`/`volta`, lockfile, `.nvmrc`. Pin Node LTS + a current pnpm.
   - DB/cache: existing `docker-compose.yml`, Prisma schema (`prisma/`), connection-string env names. If a script copies in a shared/platform schema (e.g. `prisma/copy.ts`) separately from `prisma:generate`, note it — post-create must run the copy **and** `prisma format` before generate/push (GOTCHAS #22).
   - Auth: NextAuth/Auth0/OIDC? Find the issuer env (e.g. `AUTH0_ISSUER`) and how role/identity is derived. If it's standard OIDC discovery, a mock slots in with ~zero code change.
   - Secrets today: Infisical? `.env`? List the env vars the app actually reads.
2. **Scaffold `.devcontainer/`** from `references/` (see [REFERENCE.md](REFERENCE.md) for each file + placeholders):
   - `docker-compose.yml` — `app` (build from `Dockerfile`) + `postgres` + `redis` + `oidc` mock. Self-contained; do **not** extend the root compose.
   - `Dockerfile` — glibc base (`node:<LTS>-bookworm-slim`) for painless native binaries (Prisma/esbuild/sharp); install pnpm via `npm i -g`.
   - `devcontainer.json` — wire `postCreateCommand` / `postStartCommand`.
   - `devcontainer.env` — **committed, dev-only** values (no real secrets). This is the "example that just works".
   - `post-create.sh` — install → generate client → push schema (retry through DB warmup) → seed.
   - `post-start.sh` — launch the dev server **fully detached**.
   - `README.md` — run instructions + the routing trade-off.
3. **Wire self-contained auth** (if the app authenticates): run the OIDC mock (`navikt/mock-oauth2-server`) as a **sidecar** (`network_mode: service:app`) and route it via devrouter at `https://oidc.<app>.localhost/default`. The browser (authorize) and the app server (discovery/token/jwks) use the SAME issuer host → consistent token `iss`. Server-side reachability needs `extra_hosts: ['oidc.<app>.localhost:host-gateway']` + trusting the mkcert CA (`NODE_EXTRA_CA_CERTS`) — **never** `NODE_TLS_REJECT_UNAUTHORIZED=0`. One-click auto-login with constant claims (stable `sub`). See [GOTCHAS.md](GOTCHAS.md) #3, #16.
4. **Add `.devrouter.yml`** (`references/devrouter.yml`, copied to the repo root): `runtime: proxy` routes over `devnet` — `app` + `oidc` (http) and `db` + `redis` (tcp/SNI), each `upstream: ${WORKSPACE}-<svc>:<port>`. Attach the services to `devnet` with the matching `${WORKSPACE:-<app>}-<svc>` aliases in the compose; **no published host ports**. The `${WORKSPACE}` token keeps the route and the devnet alias on one identity: the primary checkout resolves it to the project name (unchanged), while a parallel worktree resolves it to `<ws>-*` (see "Parallel worktrees" below). No `hostRun`/`docker`/`dependencies`/`secretManager` — the container owns those. Requires devrouter ≥ 0.0.21 (the `${WORKSPACE}` upstream token requires ≥ 0.0.22). (Full routing walkthrough: devrouter `docs/DEVCONTAINER.md`.)
5. **Document for agents** — append a short *Local development (devcontainer)* section to the repo's agent-instructions file (`AGENTS.md`, or `CLAUDE.md` if that's the file the repo already uses) from `references/AGENTS-devcontainer.md`. It tells future agents to use the devcontainer as the default local path (not the old host-port/Infisical/Auth0 setup): bring it up with `devpod up .`, run commands/tests/prisma **inside** the container, reach the app at the routed URLs, and log in one-click. Fold the devrouter prerequisites (`dev up && dev tls install`, then the `dev app run` routes) in as the routing layer **when devrouter is in use** — keep the devcontainer instructions usable on their own so the guidance degrades gracefully where devrouter isn't installed.
6. **Verify end-to-end** (mandatory before claiming done) — `dev up && dev tls install` first, then a clean `devpod up .` (exits 0), then `for a in app oidc db redis; do dev app run "$a"; done`, then the **curl matrix** (browser-independent, reliable):
   ```bash
   curl -sS -o /dev/null -w "app=%{http_code}\n"  https://<app>.localhost/
   curl -sS -o /dev/null -w "oidc=%{http_code}\n" https://oidc.<app>.localhost/default/.well-known/openid-configuration
   psql "host=db.<app>.localhost port=5432 user=<u> password=<p> dbname=<d> sslmode=require sslnegotiation=direct" -tAc "select 1"
   # only if the app uses Redis:
   redis-cli -h redis.<app>.localhost -p 6379 --tls --sni redis.<app>.localhost --cacert "$(mkcert -CAROOT)/rootCA.pem" PING
   # server-side issuer reachability (inside the app container):
   docker exec <app>-app-1 node -e "fetch(process.env.AUTH0_ISSUER+'/.well-known/openid-configuration').then(r=>console.log(r.status))"
   ```
   For the login itself, drive the browser if available; otherwise confirm the post-callback session (`fetch('/api/auth/session')` in-page → `{ email, role }`). Confirm the committed `devcontainer.env` contains **no real secrets**.

## Parallel worktrees (workspace isolation)

The templates are workspace-aware so several git worktrees of one repo run at once with no host/alias collisions (devrouter ≥ 0.0.22):

- Compose aliases use `${WORKSPACE:-<app>}-*` and `.devrouter.yml` upstreams use `${WORKSPACE}-*`. The **primary checkout** leaves `WORKSPACE` unset → both resolve to `<app>-*` (identical to the old behavior); `devcontainer.env` carries `WORKSPACE=<app>` as the container-side default.
- For a **parallel worktree**, `dev workspace up <branch>` creates the worktree, exports `WORKSPACE=<ws>` to the devpod/compose env (so the container's alias becomes `<ws>-app`), and registers the namespaced host `<app>.<ws>.localhost` → `<ws>-app`. `dev workspace ls` lists them; `dev workspace down <branch>` frees routes + stops the devpod + removes the worktree.
- Without `dev workspace up` (e.g. a manual `devpod up`), set `WORKSPACE=<ws>` in the worktree's `.devcontainer/.env` or export it before bringing the stack up — the shell env is what drives the `${WORKSPACE}` compose substitution (same mechanism as the existing `${HOME}`/`${DEVROUTER_MKCERT_CAROOT}` mount).
- `dev doctor` reports routes left behind by a worktree removed without `dev workspace down`; it does not mutate route state.

## Hard-won gotchas

**Read [GOTCHAS.md](GOTCHAS.md) before scaffolding.** These are the traps that cost the most time (env_file `=` truncation, detached dev server hanging `devpod up`, OIDC issuer/netns, `--recreate` not recreating sidecars, named `node_modules` volumes, …). Skipping them reproduces the same failures.

## Guardrails

- **Never commit real secrets.** `devcontainer.env` is dev-only by construction; real secrets stay in the existing secret manager for non-container workflows.
- Keep the change minimal and stack-faithful — mirror the repo's existing DB creds / service versions; don't introduce new tools.
- **No published host ports.** Attach routable services to the external `devnet` network with stable aliases and let devrouter route by name (GOTCHAS #11). That is what lets N devcontainers coexist and keeps `:80/:443/:5432/:6379` (and the dashboard `:8080`) collision-free.

## Migrating an existing host-port onboard to devnet

A repo onboarded with the pre-0.0.21 pattern publishes `127.0.0.1:<port>` and has a single `upstream: 127.0.0.1:<port>` route. To migrate (the gbl-uzh demo-game is the worked example): drop the compose `ports:`, attach `app`/`postgres`/`redis` to `devnet` with aliases, add the OIDC `extra_hosts` + mkcert CA mount, switch `.devrouter.yml` to the devnet upstreams + `oidc`/`db`(/`redis`) routes, point `devcontainer.env` auth URLs at the routed https hosts (+ `NODE_EXTRA_CA_CERTS`), and add the no-TTY pnpm exports (GOTCHAS #18). Validate with a clean `devpod delete && devpod up` (GOTCHAS #20). If the old route still claims the hostname, free it per GOTCHAS #19.
