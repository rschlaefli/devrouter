---
name: devcontainer-onboarding
description: Onboard a repo to a self-contained devcontainer (app + Postgres + Redis + local OIDC mock) fronted by proxy-only devrouter routing. Use when adding a `.devcontainer/`, replacing manual local setup (Infisical/Auth0/host DBs) with a clone-and-run stack, or migrating a repo to the devcontainer-first approach. Targets Node/pnpm/Prisma/Next + Auth0/OIDC apps; the pattern generalizes.
user-invocable: true
---

# devcontainer onboarding

Make a repo **clone-and-run**: `devpod up .` (or any devcontainer-spec tool — VS Code Dev Containers, `@devcontainers/cli`, Codespaces) brings up the full app with **zero manual steps and no external services**. devrouter is layered on top as a thin **routing-only** front (optional). Clean split: the **container owns the environment**, **devrouter owns the routing**.

The reference implementation this skill generalizes is `derivatives-game/.devcontainer/` (Next + Prisma + Postgres + Redis, Auth0 replaced by a local OIDC mock).

## When NOT to use

- The repo already has a working `.devcontainer/` → adjust it, don't re-scaffold.
- The app needs a real external service that can't be mocked/containerized locally → containerize what you can, document the rest; don't fake credentials for a live API.

## Workflow

1. **Detect the stack** (read, don't assume):
   - Package manager + versions: `package.json` `packageManager`/`volta`, lockfile, `.nvmrc`. Pin Node LTS + a current pnpm.
   - DB/cache: existing `docker-compose.yml`, Prisma schema (`prisma/`), connection-string env names.
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
3. **Wire self-contained auth** (if the app authenticates): run the OIDC mock (`navikt/mock-oauth2-server`) as a **sidecar** (`network_mode: service:app`) so the issuer URL is identical from the app server and the host browser. One-click auto-login with constant claims (stable `sub`). See [GOTCHAS.md](GOTCHAS.md) #1.
4. **Add proxy-only `.devrouter.yml`** (`references/devrouter.yml`): a single `runtime: proxy` app → the container's published `127.0.0.1:<port>`. No `hostRun`/`docker`/`dependencies`/`secretManager` — the container owns those. Requires devrouter ≥ 0.0.20. (Full routing walkthrough: devrouter `docs/DEVCONTAINER.md`.)
5. **Verify end-to-end** (mandatory before claiming done):
   - `devpod up .` exits 0 on a clean checkout; app reachable on its published port; one-click login lands authenticated.
   - Optional routing: `dev up && dev app run app` → curl the `*.localhost` host → 200.
   - Confirm the committed `devcontainer.env` contains **no real secrets**.

## Hard-won gotchas

**Read [GOTCHAS.md](GOTCHAS.md) before scaffolding.** These are the traps that cost the most time (env_file `=` truncation, detached dev server hanging `devpod up`, OIDC issuer/netns, `--recreate` not recreating sidecars, named `node_modules` volumes, …). Skipping them reproduces the same failures.

## Guardrails

- **Never commit real secrets.** `devcontainer.env` is dev-only by construction; real secrets stay in the existing secret manager for non-container workflows.
- Keep the change minimal and stack-faithful — mirror the repo's existing DB creds / service versions; don't introduce new tools.
- Publish app + aux ports on `127.0.0.1` via compose `ports:` (not only DevPod `forwardPorts`) so the host browser reaches them without an IDE session — but never publish ports devrouter owns (80/443/5432) or that collide with its dashboard (`127.0.0.1:8080`).
