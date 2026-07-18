---
name: devcontainer-onboarding
description: Onboard a repo to a self-contained devcontainer (app + Postgres + Redis + local OIDC mock) fronted by devrouter over the shared `devnet` network with zero published host ports, so many devcontainers run at once. Use when adding a `.devcontainer/`, replacing manual local setup (Infisical/Auth0/host DBs) with a clone-and-run stack, migrating a repo to the devcontainer-first approach, or moving an older host-port onboard to devnet. Targets Node/pnpm/Prisma/Next + Auth0/OIDC apps; the pattern generalizes.
user-invocable: true
---

# devcontainer onboarding

Make a repo **clone-and-run**: after one-time `devrouter setup --yes`, `devrouter ensure .` brings up and proves the full app for either a primary or linked checkout. Devrouter fronts it over the shared external `devnet` network with **no published host ports**, so many devcontainers (app + DB + OIDC each) run simultaneously with zero collisions and the DBs are reachable from host tooling via `db.<app>.localhost`. Clean split: the **container owns the environment**, **devrouter owns the routing**.

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
   - Preflight: `devrouter setup --yes --json`, `devrouter doctor --json`, then product facts with `devrouter repo inspect --json`.
   - Package manager + versions: `package.json` `packageManager`/`volta`, lockfile, `.nvmrc`. Pin Node LTS + a current pnpm.
   - DB/cache: existing `docker-compose.yml`, Prisma schema (`prisma/`), connection-string env names. If a script copies in a shared/platform schema (e.g. `prisma/copy.ts`) separately from `prisma:generate`, note it — post-create must run the copy **and** `prisma format` before generate/push (GOTCHAS #22).
   - Auth: NextAuth/Auth0/OIDC? Find the issuer env (e.g. `AUTH0_ISSUER`) and how role/identity is derived. If it's standard OIDC discovery, a mock slots in with ~zero code change.
   - Secrets today: Infisical? `.env`? List the env vars the app actually reads.
2. **Write the scaffold**:
   - CLI scaffold: for the supported app + Postgres Node/pnpm shape, use the product CLI first:
     ```bash
     devrouter repo devcontainer write --dry-run --json
     devrouter repo devcontainer write --yes
     ```
   - Manual references: use `references/` (see [REFERENCE.md](REFERENCE.md)) only when the repo needs Redis, OIDC, a monorepo variant, or another shape outside the first product scaffold.
   - `docker-compose.yml` — product CLI writes `app` (build from `Dockerfile`) + `postgres`; manual references can add `redis` and an `oidc` mock. Self-contained; do **not** extend the root compose.
   - `Dockerfile` — glibc base (`node:<LTS>-bookworm-slim`) for painless native binaries (Prisma/esbuild/sharp); install pnpm via `npm i -g`.
   - `devcontainer.json` — wire `postCreateCommand` and select `${localEnv:DEVCONTAINER_COMPOSE_OVERLAY:docker-compose.default.yml}` after the base compose file. Do not wire `postStartCommand`; `devrouter ensure` invokes the adapter after runtime helper delivery.
   - `docker-compose.default.yml` / `docker-compose.devrouter.yml` — keep primary-checkout startup unchanged; the devrouter overlay mounts `${DEVROUTER_GIT_COMMON_DIR}` at the same absolute path so linked-worktree Git works in DevPod.
   - `devcontainer.env` — **committed, dev-only** values (no real secrets). This is the "example that just works".
   - `post-create.sh` — install → generate client → push schema (retry through DB warmup) → seed.
   - `post-start.sh` — keep the repository-owned environment and command, require `DEVROUTER_PROCESS_HELPER`, and delegate process ownership to `"$DEVROUTER_PROCESS_HELPER" ensure`. Devrouter snapshots and fingerprints the adapter. If a non-secret runtime value such as a public origin affects process reuse, name it in `DEVROUTER_PROCESS_FINGERPRINT_ENV`; never add secret-like names. Do not install devrouter in the image or hand-roll `pgrep`/`setsid` lifecycle logic.
   - `README.md` — run instructions + the routing trade-off.
3. **Wire self-contained auth** (if the app authenticates): run the OIDC mock (`navikt/mock-oauth2-server`) as a **sidecar** (`network_mode: service:app`) and route it via devrouter at `https://oidc.<app>.localhost/default`. The browser (authorize) and the app server (discovery/token/jwks) use the SAME issuer host → consistent token `iss`. Server-side reachability needs `extra_hosts: ['oidc.<app>.localhost:host-gateway']` + trusting the mkcert CA (`NODE_EXTRA_CA_CERTS`) — **never** `NODE_TLS_REJECT_UNAUTHORIZED=0`. One-click auto-login with constant claims (stable `sub`). See [GOTCHAS.md](GOTCHAS.md) #3, #16.
4. **Add `.devrouter.yml`** (`references/devrouter.yml`, copied to the repo root): `runtime: proxy` routes over `devnet` — `app` + `oidc` (http) and `db` + `redis` (tcp/SNI), each `upstream: ${WORKSPACE}-<svc>:<port>`. Attach the services to `devnet` with the matching `${WORKSPACE:-<app>}-<svc>` aliases in the compose; **no published host ports**. The `${WORKSPACE}` token keeps the route and the devnet alias on one identity: the primary checkout resolves it to the project name (unchanged), while a parallel worktree resolves it to `<ws>-*` (see "Parallel worktrees" below). No `hostRun`/`docker`/`dependencies`/`secretManager` — the container owns those. Requires devrouter ≥ 0.0.21 (the `${WORKSPACE}` upstream token requires ≥ 0.0.22). (Full routing walkthrough: devrouter `docs/DEVCONTAINER.md`.)
5. **Document for agents** — append a short *Local development (devcontainer)* section to the repo's agent-instructions file (`AGENTS.md`, or `CLAUDE.md` if that's the file the repo already uses) from `references/AGENTS-devcontainer.md`. It tells future agents to use `devrouter ensure .` for either checkout kind, use `devrouter exec . -- <command...>` for container commands, reach the app at the routed URLs, and log in one-click. Prefer `devrouter repo agents` when the target repo should also receive the bundled devrouter skill.
6. **Verify end-to-end** (mandatory before claiming done) — run static product evidence first:
   ```bash
   devrouter setup --yes --json
   devrouter doctor --json
   devrouter repo devcontainer verify --json
   ```
   Then start and prove either checkout kind:
   ```bash
   devrouter ensure . --json
   ```
   Use the manual **curl matrix** only for deeper app-specific evidence or when the repo has extra routes beyond the current product scaffold:
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

- Compose aliases use `${WORKSPACE:-<app>}-*` and every HTTP/TCP `.devrouter.yml` upstream uses `${WORKSPACE}-*`. The **primary checkout** leaves `WORKSPACE` unset → both resolve to `<app>-*` (identical to the old behavior); `devcontainer.env` carries `WORKSPACE=<app>` as the container-side default. Managed `ensure` rejects a foreign alias before any DevPod or route mutation.
- For a **parallel worktree**, `devrouter workspace up <branch>` creates it under the repository's ignored `trees/<workspace>` directory and starts it. In any existing checkout, `devrouter ensure .` is canonical: it selects the checkout kind, persists linked identity where needed, starts or attaches the exact-path DevPod, proves the runtime, and only then registers routes. `workspace ls` lists linked workspaces; `workspace down` serializes destructive linked teardown with ensure.
- Do not branch manually between bare `devpod up` for primary and workspace commands for linked checkouts. Do not use raw `devpod stop/delete` either: those calls bypass devrouter's machine-wide ownership lock. Use `devrouter ensure .`, `devrouter stop . [--delete]`, or the matching workspace command and fix the reported invariant instead of manually reconnecting containers or routes.
- `devrouter doctor` reports routes left behind by a worktree removed without `devrouter workspace down`; it does not mutate route state.

## Hard-won gotchas

**Read [GOTCHAS.md](GOTCHAS.md) before scaffolding.** These are the traps that cost the most time (env_file `=` truncation, runtime helper ownership, OIDC issuer/netns, `--recreate` not recreating sidecars, named `node_modules` volumes, …). Skipping them reproduces the same failures.

## Guardrails

- **Never commit real secrets.** `devcontainer.env` is dev-only by construction; real secrets stay in the existing secret manager for non-container workflows.
- Keep the change minimal and stack-faithful — mirror the repo's existing DB creds / service versions; don't introduce new tools.
- **No published host ports.** Attach routable services to the external `devnet` network with stable aliases and let devrouter route by name (GOTCHAS #11). That is what lets N devcontainers coexist and keeps `:80/:443/:5432/:6379` (and the dashboard `:8080`) collision-free.

## Migrating an existing host-port onboard to devnet

A repo onboarded with the pre-0.0.21 pattern publishes `127.0.0.1:<port>` and has a single `upstream: 127.0.0.1:<port>` route. To migrate (the gbl-uzh demo-game is the worked example): drop the compose `ports:`, attach `app`/`postgres`/`redis` to `devnet` with aliases, add the OIDC `extra_hosts` + mkcert CA mount, switch `.devrouter.yml` to the devnet upstreams + `oidc`/`db`(/`redis`) routes, point `devcontainer.env` auth URLs at the routed https hosts (+ `NODE_EXTRA_CA_CERTS`), and add the no-TTY pnpm exports (GOTCHAS #18). Validate with `devrouter ensure .`; if a stale container still violates the proven compose contract, follow ensure's exact remediation instead of deleting an unrelated DevPod (GOTCHAS #20). If the old route still claims the hostname, free it per GOTCHAS #19.
