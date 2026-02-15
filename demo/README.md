# Demo Workspace

This folder is a complete demo repository for `devrouter`:

- `web-host`: HTTP app running on host via `node app/server.js`
- `web-docker`: same app running inside Docker
- `db`: PostgreSQL in Docker routed over shared `:5432`

The demo keeps routing-focused entries only; dependency-only `kind: dependency` services (for example Redis) are supported by devrouter but not required for this baseline demo.

The `docker-compose.yml` here serves as a reference for devrouter compose conventions: services include healthchecks (required for `--wait`) and do not publish host ports (devrouter handles routing via Traefik).

## Files

- `.devrouter.yml`: complete repo routing config
- `docker-compose.yml`: Docker services (`app`, `db`)
- `app/server.js`: simple HTTP app used by host and Docker runtimes

## Quick run

From `/Volumes/HOME/Git/personal/devrouter`:

```bash
dev init --repo ./demo
dev up
dev tls install
dev doctor --repo ./demo
dev app exec web-host --repo ./demo --yes -- printenv DATABASE_URL SHADOW_DATABASE_URL DB_HOST DB_PORT
dev app run web-docker --repo ./demo --yes
dev app run web-host --repo ./demo --yes
```

`dev app exec` now tears down only dependencies it started in that command. If `db` is already running (for example while `web-host` is up), an exec seed/migrate command leaves `db` running.

With Docker running normally, `dev doctor --repo ./demo` should not report `repo.postgres-credentials` mismatch warnings.
It should also not report `repo.host-command-env-precedence` warnings for wrapper precedence.
It should not report `repo.tls-host-coverage` warnings for configured demo hosts.

`dev init` prints the onboarding prompt only. To also write AGENTS/skill artifacts, run:

```bash
dev init --repo ./demo --write-agents --write-skill
```

To also bootstrap optional Linear workflow planning assets:

```bash
dev init --repo ./demo --with-linear --write-agents --write-skill
```

This captures minimal Linear mapping values (workspace/team/project) into a managed AGENTS block. In non-interactive mode placeholders are written and should be replaced later.

Required Linear execution hygiene:

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

For non-Prisma tooling in host commands, map aliases with argv-safe exec:

```bash
dev app exec web-host --repo ./demo --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI
```

If a wrapper command (Infisical/Doppler) must set `DATABASE_URI`, do it after `run --`:

```bash
infisical run --env=dev -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} pnpm dev
```

Then open:

- [https://demo-host.localhost](https://demo-host.localhost)
- [https://demo-docker.localhost](https://demo-docker.localhost)

Inspect routes:

```bash
dev ls
```

Expected DB endpoint:

- `postgres://demo-db.localhost:5432 (tls required)`
- `dev open demo-db` (or `dev open demo-db.localhost`) prints TCP connection guidance

Dependency-only note:

- `kind: dependency` entries appear in `dev app ls` but do not produce route endpoints in `dev ls`.
- direct `dev app run|exec|open <dependency-name>` is rejected with guidance to run a routed parent app.

If you change a host to a multi-segment `.localhost` value, `dev app run` / `dev app exec`
auto-refresh cert SAN coverage when TLS is enabled.

## Cleanup

Stop the `web-host` command with `Ctrl+C`, then:

```bash
docker compose -f ./demo/docker-compose.yml down -v
```
