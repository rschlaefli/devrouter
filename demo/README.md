# Demo Workspace

This folder is a complete demo repository for `devrouter`:

- `web-host`: HTTP app running on host via `node app/server.js`
- `web-docker`: same app running inside Docker
- `db`: PostgreSQL in Docker routed over shared `:5432`

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

With Docker running normally, `dev doctor --repo ./demo` should not report `repo.postgres-credentials` mismatch warnings.

`dev init` prints the onboarding prompt only. To also write AGENTS/skill artifacts, run:

```bash
dev init --repo ./demo --write-agents --write-skill
```

To also bootstrap optional Linear workflow planning assets:

```bash
dev init --repo ./demo --with-linear --write-agents --write-skill
```

This captures minimal Linear mapping values (workspace/team/project) into a managed AGENTS block. In non-interactive mode placeholders are written and should be replaced later.

For non-Prisma tooling in host commands, map aliases with argv-safe exec:

```bash
dev app exec web-host --repo ./demo --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI
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

## Cleanup

Stop the `web-host` command with `Ctrl+C`, then:

```bash
docker compose -f ./demo/docker-compose.yml down -v
```
