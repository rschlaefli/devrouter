# Remote preview planning

`devrouter preview` is an opt-in namespace for remote review environments.
This package provides offline manifest planning and a reviewable onboarding scaffold.
It does not start or delete cloud resources.

```sh
devrouter preview init --repo . --json
devrouter preview init --repo . --write
devrouter preview plan --repo . --list --json
devrouter preview plan --repo . --alias web --json
```

`init` prints YAML by default. `--write` creates only the absent
`.devrouter.preview.yml` file and refuses to overwrite it. Replace the placeholder
image before cloud use. No command installs workflows, changes provider accounts,
reads cloud credentials, starts Docker, or writes home state.

## Configuration ownership

`.devrouter.yml` owns local routing and profile membership. The separate
`.devrouter.preview.yml` describes remote bindings and resources; local commands
never load it. [ADR 0013](./adr/0013-opt-in-remote-previews.md) records this boundary.

A profile-backed alias references existing profile names. Bind each selected app,
dependency, managed service and process to resource IDs. An empty binding records
an intentional omission; an absent binding fails planning. This makes untested
coverage visible instead of silently starting a smaller environment.

A cloud-only repository can use `version: 1` and `apps: []` in `.devrouter.yml`,
with resource-backed aliases. It needs no local routes or devcontainer.

```yaml
version: 1
aliases:
  web:
    resources: [web]
bindings:
  apps: {}
  dependencies: {}
  services: {}
  processes: {}
resources:
  db:
    kind: postgres
  web:
    kind: service
    image: registry.example.org/app@sha256:0000000000000000000000000000000000000000000000000000000000000000
    dependsOn: [db]
    ports:
      - name: http
        port: 8080
        public: false
selection:
  rules:
    - paths: ['src/**']
      aliases: [web]
  ignorePaths: ['docs/**', '**/*.md']
  controlPaths: []
  fallback: web
  allowedUnions: []
```

The strict version-1 manifest rejects unknown fields, duplicate YAML keys,
YAML aliases, invalid references and resource cycles. Services and jobs select
one image or build recipe. Builds use repository-relative context/Dockerfile
paths. Planning never executes application commands. Resources form a dependency
graph, emitted in deterministic dependency order.

## Manual and automatic selection

`--alias chat` selects one declared alias; `--alias chat,ai` requires that union in
`selection.allowedUnions`. Alias profile names are resolved by the existing local
profile resolver. Public alias names need not equal local profile names.

For automatic selection, provide a repository-relative JSON file with `--source`:

```json
{
  "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "target": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "mergeBase": "cccccccccccccccccccccccccccccccccccccccc",
  "complete": true,
  "changes": [{ "status": "M", "path": "src/app.ts" }]
}
```

The report binds the source identities and config digests. Source metadata is
input to offline planning, not proof of forge authorization or permission to deploy.
Manual plans without source identity remain unbound and cannot authorize effects.

Selection globs support only `*`, `**` and `?`; unsupported brace, bracket, negation
or extglob syntax fails validation. Automatic rules collect all matching aliases. A configured `dominating` alias may
collapse that union; `allowedUnions` bounds other combinations. Unmatched executable
paths select the configured fallback or require manual selection. Documentation-only
changes emit `no-runtime`. Incomplete changes emit `unknown`. Control-file changes
emit `review-required`, including manual selection; built-in controls include both
Devrouter config files, GitHub workflows and CI paths. Renames consider both paths.

## Support boundary

The CLI currently inspects the proposed resource graph. It has no live deployment,
forge comment handler, access-policy enforcement or expiry capability. A successful
plan is not a running or qualified preview. The accepted lifecycle and qualification
work are recorded in the [implementation plan](./project/2026-10-25-cloud-preview-environments-plan.md).

## Durable control building blocks

The source includes a conditional state-store interface and an Azure Blob transport.
The adapter requires a public-cloud HTTPS container endpoint and a runtime-injected
Bearer token callback. It never creates accounts, containers or credentials.
State mutations use conditional creation or the exact read ETag; an uncertain write
is reconciled rather than blindly retried. Missing established state requires
explicit installation initialization instead of silently recreating an empty pool.

These building blocks are not wired to cloud resource effects. The lifecycle
engine and live qualification remain separate from a successful offline plan.

`pnpm qualify:preview-control` exercises synthetic late-allocation cleanup and
conditional concurrent writes without a network or account. It identifies its
transport as simulated. This is regression proof, not live provider qualification.
