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
- **`devrouter workspace up/ensure/ls/stop/down/gc`** — worktree creation,
  proven DevPod startup/reconciliation, ownership state, pause, teardown, and
  missing-owner cleanup
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
3. `devrouter workspace up feat-a --no-devpod` creates only the `feat-a`
   worktree. `WORKSPACE=feat-a docker compose -p wsfeata up -d` brings up its
   alias, then `devrouter app run app --repo <worktree> --yes` registers
   `wsdemo.feat-a.localhost` → `feat-a-app`.
4. `curl` both hosts; `devrouter workspace ls`.

`--no-devpod` is used so the example needs only Docker (no devpod/devcontainer).
With a devcontainer, `devrouter workspace up <branch>` brings the container up for you
and exports `WORKSPACE=<ws>` so the alias substitution happens automatically.
Inside any existing checkout, use `devrouter ensure .`; it reuses
the exact-path DevPod or starts it, then proves the runtime before registering routes.

Teardown stops the compose projects, frees their routes, and runs
`devrouter workspace down feat-a`, which removes only a clean, unlocked worktree.
Use `workspace stop` when the checkout and data should remain. If the worktree is
removed outside devrouter, review `workspace gc` before applying it with `--yes`.
