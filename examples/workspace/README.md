# Workspace isolation example

Runnable showcase of devrouter **workspace isolation**: one repo, several git
worktrees running in parallel, each on its own namespaced `*.localhost` with no
host/route collisions. This is the pattern agents use to run many feature
branches of the same app at once.

What it demonstrates:

- **`${WORKSPACE}` upstream token** — the proxy `upstream` is `${WORKSPACE}-app:3000`,
  substituted at runtime with the resolved workspace token.
- **Auto host namespacing** — `wsdemo.localhost` becomes `wsdemo.<ws>.localhost`
  for a worktree; the committed `.devrouter.yml` is never rewritten.
- **`devrouter workspace up/ls/down`** — worktree + (optional devpod) + namespaced routes
  in one command.
- **Matching devnet alias** — the compose service joins `devnet` as
  `${WORKSPACE:-wsdemo}-app`, so the alias and the route resolve to one identity.

## Files

| File | Purpose |
| --- | --- |
| `.devrouter.yml` | proxy app: `host: wsdemo.localhost`, `upstream: ${WORKSPACE}-app:3000` |
| `docker-compose.yml` | one `node:20-alpine` app joining `devnet` as `${WORKSPACE:-wsdemo}-app` |
| `server.js` | zero-dep HTTP server that echoes its `WORKSPACE` |
| `run.sh` | brings the whole thing up, prints the proof, tears down |

## Run it

Prerequisites: Docker, and devrouter built (`pnpm build`, or `dev` on `PATH`).

```bash
./run.sh          # primary + a `feat-a` worktree, both reachable; prints proof
./run.sh down     # tear everything down
```

Expected proof:

```
wsdemo.localhost         -> hello from devrouter workspace="wsdemo"
wsdemo.feat-a.localhost  -> hello from devrouter workspace="feat-a"
```

Two instances of the same app, same code, distinct hosts — served simultaneously.

## How `run.sh` works

`devrouter workspace` operates on a repo root, so the script copies this example into a
standalone git repo under `/tmp/devrouter-wsdemo` (override with `WSDEMO_REPO`),
then:

1. `devrouter up` + `devrouter tls install` — shared router, `devnet`, mkcert CA.
2. Primary checkout: `WORKSPACE=wsdemo docker compose -p wsdemo up -d` (alias
   `wsdemo-app`) → `devrouter app run app` registers `wsdemo.localhost` → `wsdemo-app`.
3. `devrouter workspace up feat-a --no-devpod` — creates the `feat-a` worktree and
   registers `wsdemo.feat-a.localhost` → `feat-a-app`; then
   `WORKSPACE=feat-a docker compose -p wsfeata up -d` brings up that alias.
4. `curl` both hosts; `devrouter workspace ls`.

`--no-devpod` is used so the example needs only Docker (no devpod/devcontainer).
With a devcontainer, `devrouter workspace up <branch>` brings the container up for you
and exports `WORKSPACE=<ws>` so the alias substitution happens automatically.

Teardown frees the routes (`devrouter workspace down feat-a`, `devrouter app rm`), stops both
compose projects, and removes the temp repo + worktree.
