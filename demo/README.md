# Demo Workspace

This folder is a complete demo repository for `devrouter`:

- `web-host`: HTTP app running on host via `node app/server.js`
- `web-docker`: same app running inside Docker
- `db`: PostgreSQL in Docker routed over shared `:5432`

## Files

- `.devrouter.yml`: complete repo routing config
- `docker-compose.yml`: Docker services (`app`, `db`)
- `app/server.js`: simple HTTP app used by host and Docker runtimes

## Quick run

From `/Volumes/MOBILE/Git/devrouter`:

```bash
dev up
dev tls install
dev app run web-docker --repo ./demo --yes
dev app run web-host --repo ./demo --yes
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

## Cleanup

Stop the `web-host` command with `Ctrl+C`, then:

```bash
docker compose -f ./demo/docker-compose.yml down -v
```
