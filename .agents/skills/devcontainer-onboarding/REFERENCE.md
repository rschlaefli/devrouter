# Reference templates

Copy the files in `references/` into the target repo's `.devcontainer/` (and the
repo root for `.devrouter.yml`), then substitute the placeholders. They are the
generalized form of verified working stacks (derivatives-game, careers,
gbl-uzh demo-game); keep the structure, adapt the stack-specific commands.

## Placeholders

| Token | Meaning | Example |
| --- | --- | --- |
| `{{APP}}` | repo / workspace folder name. Also the routed host (`{{APP}}.localhost`) and the devnet alias prefix (`{{APP}}-app`, `{{APP}}-db`, `{{APP}}-redis`) | `derivatives-game` |
| `{{NODE}}` | Node LTS major | `24` |
| `{{PNPM}}` | pinned pnpm version | `11.6.0` |
| `{{PKG}}` | workspace filter for the app package | `@derivatives-game/next` |
| `{{APP_PORT}}` | dev server port *inside* the container (no longer published) | `3000` |
| `{{OIDC_PORT}}` | OIDC mock port inside the app netns | `8090` |
| `{{DB_USER}}` / `{{DB_PASS}}` / `{{DB_NAME}}` | dev DB creds (mirror the repo's existing compose) | `prisma` |
| `{{ADMIN_EMAIL}}` | one-click dev admin email | `admin@example.com` |
| `{{ADMIN_SUB}}` | stable OIDC `sub` | `dev-admin` |

The devnet alias just needs to be unique across all routed devcontainers;
`{{APP}}-app`/`-db`/`-redis` derive it from `{{APP}}` and stay collision-free.

## Files

- **`docker-compose.yml`** — `app` + `postgres` + `redis` + `oidc`. Self-contained
  (don't extend the root compose). **No published host ports**: `app`/`postgres`/
  `redis` join the external `devnet` network with aliases; the `oidc` sidecar
  (`network_mode: service:app`) rides the app's netns. Keep `init: true`, the
  named `node_modules` volumes, the `extra_hosts` host-gateway mapping for the
  OIDC host, and the read-only mkcert root-CA mount. Drop `redis`/`oidc` (and
  their routes) if the app doesn't use them.
- **`Dockerfile`** — glibc base for native binaries; pnpm via `npm i -g`. Add OS
  packages the app needs at dev time (git, openssl, procps for `pgrep`, curl).
- **`devcontainer.json`** — points at the compose `app` service and wires the two
  lifecycle hooks. The `_ports` note documents the devrouter-only access. Add
  editor extensions as desired.
- **`devcontainer.env`** — **committed, dev-only**. Every var the app reads,
  pointed at the in-compose services (`postgres`, `redis`) and the **routed**
  https hosts (`NEXTAUTH_URL`/public URLs → `https://{{APP}}.localhost`, issuer →
  `https://oidc.{{APP}}.localhost/default`, plus `NODE_EXTRA_CA_CERTS`). NO real
  secrets.
- **`post-create.sh`** — no-TTY hardening (GOTCHAS #18) → install
  (`--no-frozen-lockfile`) → (optional, monorepos only) build the workspace deps
  the app imports → (if the repo copies in a shared/platform schema separately)
  `prisma:copy` **+ `prisma format`** → generate client → push schema (retry
  through DB warmup) → seed. The copy+format step is required for platform-copy
  repos or generate fails P1012 (GOTCHAS #22). Replace the Prisma/pnpm commands
  with the repo's equivalents for a non-Prisma stack.
- **`post-start.sh`** — no-TTY hardening → launch the dev server fully detached
  (GOTCHAS #2). Guard against double-start with `pgrep`.
- **`devrouter.yml`** — proxy-only routing over devnet, copied to the **repo
  root** as `.devrouter.yml`. Routes `app` + `oidc` (http) and `db` + `redis`
  (tcp/SNI). Requires devrouter ≥ 0.0.21.
- **`AGENTS-devcontainer.md`** — a snippet to **append** to the target repo's
  agent-instructions file (`AGENTS.md` or `CLAUDE.md`), so future agents default
  to the devcontainer path. Devcontainer usage stands alone; the devrouter
  routing is a clearly-marked layer "when available" (SKILL.md step 5).

## Adapting to a non-Prisma / non-Next stack

The pattern is stack-agnostic: **services on devnet + committed env + lifecycle
hooks + proxy routes**. Swap the DB-prepare step (`prisma generate/push/seed`)
for the repo's migration/seed commands, and the dev-server command for the
repo's (`pnpm dev`, `npm run dev`, `make dev`, …). Keep the gotchas — they are
about DevPod/compose/devnet/OIDC behavior, not about Prisma.
