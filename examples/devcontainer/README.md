# Devcontainer example

Runnable DevPod/devcontainer example for devrouter's agent-native onboarding
flow.

It contains:

- a zero-dependency Node HTTP app
- a Postgres service
- `.devcontainer/` with no published host ports
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

1. `dev setup --repo <example> --yes --json`
2. `dev repo devcontainer verify --repo <example> --json`
3. `WORKSPACE=devcontainer-demo devpod up <example> --id devrouter-devcontainer-demo --provider docker --ide none --open-ide=false --recreate`
4. `dev repo devcontainer verify --repo <example> --live --yes --json`
5. `curl https://devcontainer-demo.localhost`
6. `psql` direct-SSL against `prisma` and `shadow` on `db.devcontainer-demo.localhost` when available

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
