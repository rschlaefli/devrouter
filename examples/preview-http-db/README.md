# Python and Postgres preview fixture

This synthetic fixture demonstrates a cloud-only repository using resource aliases.
It uses Python with a locked PostgreSQL driver and an HTTP health endpoint. No Node,
Klicker, Hatchet or devcontainer runs in the application image.

From the Devrouter repository:

```sh
pnpm build
node dist/devrouter.js preview plan --repo examples/preview-http-db --alias web --json
uv lock --check --project examples/preview-http-db
```

The selected graph includes `db` before `web`. The Dockerfile context and path refer
to this repository, so a source build must register this repository with the provider.
For use as a standalone repository, change both paths to the repository root.

A trusted Northflank recipe needs a PostgreSQL deployment plan/version/disk allocation,
a web deployment/build plan and readiness `{port: http, path: /health}`. Bind
`DATABASE_URL` to the selected db addon key `POSTGRES_URI`. Configure the installation's
viewer allowlist, wildcard domain, rate reservation and acceptance command as described
in [Remote previews](../../docs/PREVIEWS.md). Keep database ports private. The health
endpoint runs `SELECT 1` using that environment-injected connection and returns 503
when the database is unavailable. It creates no tables or application data.

The image runs as UID/GID 65532. Its pinned source tags and uv lock provide repeatable
fixture inputs; an operator must qualify the built image by immutable digest. Do not
map a real database into this disposable fixture. Planning does not build or deploy it.

For a separately approved local run, inject a disposable `DATABASE_URL` and run
`uv run --frozen --project examples/preview-http-db python examples/preview-http-db/app.py`.
Stop that exact process after verification. Live database, container-image and cloud
qualification are not implied by the offline plan.
