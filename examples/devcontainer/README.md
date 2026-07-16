# Devcontainer example

Runnable DevPod/devcontainer example for devrouter's agent-native onboarding
flow.

It contains:

- a zero-dependency Node HTTP app
- a Postgres service
- `.devcontainer/` with no published host ports
- a default compose overlay plus the linked-worktree Git overlay used by `ensure`
- `.devrouter.yml` proxy routes using `${WORKSPACE}` upstreams
- `run.sh` for live smoke verification

## Run

Prerequisites: Docker, DevPod, mkcert, and devrouter built locally (`pnpm build`)
or installed as `dev`. The Postgres direct-SSL check runs when a local `psql`
with `sslnegotiation=direct` support is available.

```bash
./run.sh
./run.sh down
```

The smoke runs this sequence through `run.sh`:

1. `devrouter setup --repo <example> --yes --json`
2. `devrouter repo devcontainer verify --repo <example> --json`
3. `devrouter ensure <example> --json`
4. proof that the image has no `/usr/local/bin/devrouter-process` and the matching helper exists only at its runtime path
5. `devrouter exec <example> -- node -e <literal-argv-proof>`
6. trusted `curl https://devcontainer-demo.localhost` using the mkcert root CA
7. `psql` direct-SSL against `prisma` and `shadow` on `db.devcontainer-demo.localhost` when available

Expected app response:

```json
{"ok":true,"workspace":"devcontainer-demo","port":3000}
```

## Routes

| App | Route | Upstream |
| --- | --- | --- |
| `app` | `https://devcontainer-demo.localhost` | `${WORKSPACE}-app:3000` |
| `db` | `db.devcontainer-demo.localhost:5432` | `${WORKSPACE}-db:5432` |

The devcontainer compose file attaches both services to the external `devnet`
network with matching `${WORKSPACE:-devcontainer-demo}-*` aliases.

Run `devrouter ensure .` from either a primary or linked checkout. For linked
worktrees it selects `docker-compose.devrouter.yml`, supplies the host Git
common-directory bind, and proves the exact DevPod, aliases, routes, and endpoints.
Use `devrouter exec . -- <command...>` for one-shot container commands.
Use `workspace stop` to pause its DevPod/routes while preserving checkout and
data. Full `workspace down` deletes runtime/routes and removes only a clean,
unlocked worktree; `--keep-worktree` retains the checkout and owner record.
If Git removes a worktree out of band, review dry-run `workspace gc` before
applying exact ledger-owned cleanup with `--yes`. Git has no removal hook.
