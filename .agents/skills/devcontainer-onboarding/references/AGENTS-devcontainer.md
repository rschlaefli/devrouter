<!--
Snippet to APPEND to the target repo's agent-instructions file (AGENTS.md, or
CLAUDE.md if that's what the repo uses). Substitute the {{...}} placeholders
(same set as the other references). Drop the `redis` mentions if the app has no
Redis, and the OIDC/login lines if it doesn't authenticate. Keep it short — it
exists so future agents take the devcontainer path by default instead of the old
host-port / external-secrets setup.
-->

## Local development (devcontainer)

This repo is **clone-and-run** via a self-contained devcontainer (app + Postgres
+ local OIDC mock — no external Auth0, no host DB, no secret manager for dev).
**Prefer this over any host-based setup.** Run app commands, tests, prisma, and
the dev server **inside the container**, never on the host.

```bash
# one-time machine setup, then canonical startup for either checkout kind
devrouter setup --yes
devrouter ensure .
devrouter exec . -- pnpm test
```

The dev server auto-starts in the background (`tail -f /tmp/dev.log`). Re-run the
lifecycle by hand inside the container if needed:
`bash .devcontainer/post-create.sh` / `bash .devcontainer/post-start.sh`.

### Routing (devrouter — when available)

Nothing is published on the host; [devrouter](https://github.com/rschlaefli/devrouter)
fronts the stack over the shared `devnet` network.

```bash
devrouter repo devcontainer verify --json
devrouter ensure . --json
```

| What | Reachable at |
| --- | --- |
| App | `https://{{APP}}.localhost` |
| OIDC mock | `https://oidc.{{APP}}.localhost/default` |
| Postgres (host tooling) | `db.{{APP}}.localhost:5432` — `sslmode=require sslnegotiation=direct` |

Requires devrouter ≥ 0.0.32. If devrouter is not installed, the devcontainer
still builds and runs internally; expose the app another way (e.g. a temporary
`ports:` publish) — but the supported, collision-free path is devrouter.

To run **several worktrees of this repo in parallel**, use `devrouter workspace
up <branch>` to create one or `devrouter ensure .` inside any existing checkout.
Ensure selects the checkout kind, persists linked identity where needed, proves
the exact DevPod, HTTP routes, and TCP upstream ownership, and only then registers
routes. Do not branch manually between bare DevPod and workspace startup.
`devrouter workspace ls` lists linked workspaces; `devrouter workspace down
<branch>` tears one down.

### Admin login

Auth0 is replaced by a local OIDC mock — login is **one-click, no password**. Go
to `/api/auth/signin`, continue, and you are the fixed dev admin
(`{{ADMIN_EMAIL}}`, role granted by the app). See `.devcontainer/README.md` for
details and the env in `.devcontainer/devcontainer.env` (committed, dev-only — no
real secrets).
