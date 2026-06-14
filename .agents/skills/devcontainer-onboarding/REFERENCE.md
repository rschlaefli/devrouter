# Reference templates

Copy the files in `references/` into the target repo's `.devcontainer/` (and the
repo root for `.devrouter.yml`), then substitute the placeholders. They are the
generalized form of a verified working stack; keep the structure, adapt the
stack-specific commands.

## Placeholders

| Token | Meaning | Example |
| --- | --- | --- |
| `{{APP}}` | repo / workspace folder name | `derivatives-game` |
| `{{NODE}}` | Node LTS major | `24` |
| `{{PNPM}}` | pinned pnpm version | `11.6.0` |
| `{{PKG}}` | workspace filter for the app package | `@derivatives-game/next` |
| `{{APP_PORT}}` | dev server port | `3000` |
| `{{OIDC_PORT}}` | OIDC mock port (avoid 8080 — devrouter dashboard) | `8090` |
| `{{DB_USER}}` / `{{DB_PASS}}` / `{{DB_NAME}}` | dev DB creds (mirror the repo's existing compose) | `prisma` |
| `{{ADMIN_EMAIL}}` | one-click dev admin email | `gbl-dev@df.uzh.ch` |
| `{{ADMIN_SUB}}` | stable OIDC `sub` | `dev-admin` |

## Files

- **`docker-compose.yml`** — `app` + `postgres` + `redis` + `oidc`. Self-contained (don't extend the root compose). The `oidc` service is a sidecar (`network_mode: service:app`). Drop `redis`/`oidc` if the app doesn't use them. Keep `init: true`, the `127.0.0.1` port publishes, and the named `node_modules` volumes.
- **`Dockerfile`** — glibc base for native binaries; pnpm via `npm i -g`. Add OS packages the app needs at dev time (git, openssl, procps for `pgrep`, curl).
- **`devcontainer.json`** — points at the compose `app` service and wires the two lifecycle hooks. Add editor extensions as desired.
- **`devcontainer.env`** — **committed, dev-only**. Every var the app reads, pointed at the in-compose services (`postgres`, `redis`) and the local OIDC issuer. NO real secrets.
- **`post-create.sh`** — install (`--no-frozen-lockfile`) → generate client → push schema (retry through DB warmup) → seed. Replace the Prisma/pnpm commands with the repo's equivalents for a non-Prisma stack.
- **`post-start.sh`** — launch the dev server fully detached (see GOTCHAS #2). Guard against double-start with `pgrep`.
- **`devrouter.yml`** — proxy-only routing, copied to the **repo root** as `.devrouter.yml`. Optional; the container works without it.

## Adapting to a non-Prisma / non-Next stack

The pattern is stack-agnostic: **services + committed env + lifecycle hooks + optional proxy**. Swap the DB-prepare step (`prisma generate/push/seed`) for the repo's migration/seed commands, and the dev-server command for the repo's (`pnpm dev`, `npm run dev`, `make dev`, …). Keep the gotchas — they are about DevPod/compose/OIDC behavior, not about Prisma.
