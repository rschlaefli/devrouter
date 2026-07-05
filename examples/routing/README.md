# Routing Example

This folder is a complete `devrouter` example without devcontainers:

- `web-host`: HTTP app running on host via `node app/server.js`
- `web-docker`: same app running inside Docker
- `db`: PostgreSQL in Docker routed over shared `:5432`

Use this example to show that devrouter is useful on its own. Devcontainers are a separate onboarding path in [`../devcontainer`](../devcontainer).

The routing example keeps routing-focused entries only. Dependency-only `kind: dependency` services are supported by devrouter but are not required for this baseline.

The `docker-compose.yml` here serves as a reference for devrouter compose conventions: services include healthchecks (required for `--wait`) and do not publish host ports (devrouter handles routing via Traefik).

## Files

- `.devrouter.yml`: complete repo routing config
- `.devrouter.yml` `devrouter.version`: local applied devrouter release metadata for `dev -V` / `dev upgrade`
- `docker-compose.yml`: Docker services (`app`, `db`)
- `app/server.js`: simple HTTP app used by host and Docker runtimes

## Quick run

From the repository root:

```bash
dev init --repo ./examples/routing
dev -V --repo ./examples/routing
dev upgrade --repo ./examples/routing
dev setup --repo ./examples/routing --yes
dev doctor --repo ./examples/routing
dev repo inspect --repo ./examples/routing --json
dev app exec web-host --repo ./examples/routing --yes -- printenv DB_URL DATABASE_URL DB_SHADOW_URL SHADOW_DATABASE_URL DB_HOST DB_PORT
dev app run web-docker --repo ./examples/routing --yes
dev app run web-host --repo ./examples/routing --yes
```

`dev app exec` now tears down only dependencies it started in that command. If `db` is already running (for example while `web-host` is up), an exec seed/migrate command leaves `db` running.

Runtime verification is Docker-permitting. If Docker is unavailable or socket access is restricted, treat runtime failures as environment-blocked.
When Docker is available, `dev doctor --repo ./examples/routing` should not report `repo.postgres-credentials` mismatch warnings.
It should also not report `repo.host-command-env-precedence` warnings for wrapper precedence.
It should not report `repo.tls-host-coverage` warnings for configured routing hosts.

`dev init` prints the onboarding prompt only. To also write AGENTS/skill artifacts, run:

```bash
dev init --repo ./examples/routing --write-agents --write-skill
```

To also bootstrap optional Linear workflow planning assets:

```bash
dev init --repo ./examples/routing --with-linear --write-agents --write-skill
```

This captures minimal Linear mapping values (workspace/team/project) into a managed AGENTS block. In non-interactive mode placeholders are written and should be replaced later.

Required Linear execution hygiene:

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

For non-Prisma tooling in host commands, declare aliases in `.devrouter.yml` with dependency `envMap` and run argv-safe exec:

```bash
dev app exec web-host --repo ./examples/routing --yes -- printenv DB_URL DATABASE_URL DIRECT_URL DB_SHADOW_URL SHADOW_DATABASE_URL
```

If a wrapper command (Infisical/Doppler) must set `DATABASE_URI`, do it after `run --`:

```bash
infisical run --env=dev -- env DATABASE_URI=${DB_URL:?missing DB_URL} pnpm dev
```

Then open:

- [https://routing-host.localhost](https://routing-host.localhost)
- [https://routing-docker.localhost](https://routing-docker.localhost)

Inspect routes:

```bash
dev ls
```

Expected DB endpoint:

- `postgres://routing-db.localhost:5432 (tls required)`
- `dev open routing-db` (or `dev open routing-db.localhost`) prints TCP connection guidance

Dependency-only note:

- `kind: dependency` entries appear in `dev app ls` but do not produce route endpoints in `dev ls`.
- direct `dev app run|exec|open <dependency-name>` is rejected with guidance to run a routed parent app.

If you change a host to a multi-segment `.localhost` value, `dev app run` / `dev app exec`
auto-refresh cert SAN coverage when TLS is enabled.

## Parallel worktrees (workspace isolation)

To run multiple branches of this repo side-by-side without host collisions, use `dev workspace`:

```bash
dev workspace up feat/my-feature   # create worktree, start devpod, register namespaced routes
dev workspace ls                   # list worktrees with workspace tokens and route counts
dev workspace down feat/my-feature # free routes, stop devpod, remove worktree
```

When a workspace token (e.g. `feat-my-feature`) is active, hosts are auto-namespaced in memory:
`routing-host.localhost` → `routing-host.feat-my-feature.localhost`. The committed `.devrouter.yml` is never
modified.

For proxy apps (`runtime: proxy`), use `${WORKSPACE}` in the `upstream` field so devrouter substitutes
the active token at runtime — for example `upstream: ${WORKSPACE}-app:3000` resolves to
`feat-my-feature-app:3000` for workspace `feat-my-feature`.

See [`../../docs/GETTING_STARTED.md`](../../docs/GETTING_STARTED.md) section 15 for the full workspace workflow.

## Cleanup

Stop the `web-host` command with `Ctrl+C`, then:

```bash
docker compose -f ./examples/routing/docker-compose.yml down -v
```
