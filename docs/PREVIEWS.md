# Remote previews

`devrouter preview` is an opt-in namespace for remote review environments.
Offline planning needs no credentials. Installed controllers reconcile explicit PR commands
through a qualified Northflank provider and private Azure Blob state. Cloud admission stays
disabled until the installation supplies the required qualification evidence.

```sh
devrouter preview init --repo . --json
devrouter preview init --repo . --write
devrouter preview plan --repo . --list --json
devrouter preview plan --repo . --alias web --json
```

`init` prints YAML by default. `--write` creates only the absent
`.devrouter.preview.yml` file and refuses to overwrite it. Replace the placeholder
image before cloud use. Planning and scaffolding need no cloud credentials or local runtime.
Installation commands use explicitly injected credentials and reviewed operator policy.

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

The CLI plans offline and composes an installed forge controller, durable lifecycle
and Northflank adapter. A successful plan or source test does not qualify a running
preview. Installation-specific live proofs gate admission.

## Durable control building blocks

The source includes a conditional state-store interface and an Azure Blob transport.
The adapter requires a public-cloud HTTPS container endpoint and a runtime-injected
Bearer token callback. It never creates accounts, containers or credentials.
State mutations use conditional creation or the exact read ETag; an uncertain write
is reconciled rather than blindly retried. Missing established state requires
explicit installation initialization instead of silently recreating an empty pool.

The installed controller connects these building blocks to qualified provider effects.
The lifecycle handles explicit updates, fixed confirmed extensions and cleanup fences.
Live provider qualification remains separate from a successful offline plan.

`pnpm qualify:preview-control` exercises synthetic late-allocation cleanup and
conditional concurrent writes without a network or account. It identifies its
transport as simulated. This is regression proof, not live provider qualification.

The provider-neutral engine records operation intent and reserves capacity before
dispatch. A lost response is observed through its recorded request identity.
Cleanup observations bind the ownership version from the snapshot checked at the
provider; a conflict never upgrades old absence evidence to newer ownership.
The engine is verified with simulated provider transports. Installation dispatch
requires separately qualified provider, state and access controls.

The internal conditional-state prototype currently supports at most four active
sessions per installation. It rejects larger capacity settings explicitly.
Plans are bounded to32KiB, provider ownership receipts to64identifiers of128characters,
and replay receipts to1024within the configured command-age window.
Verified terminal sessions are removed after that window; cleanup keeps its
metadata reserve. These prototype bounds are independent of cloud quotas.

Ownership overflow is persisted and forces cleanup. A provider must discover and
delete the entire generation independently of the bounded receipt list, then
prove absence before capacity is released.

## Northflank provider source

The internal Northflank adapter compiles explicit installation recipes into staged
native preview blueprints. It creates an empty generation first, confirms its
absolute expiry, prepares private dependencies and inactive services, injects
runtime secrets into restricted groups, then activates and checks the application.
The admitted SHA pins source builds; image recipes require digests. Every public
port carries the installation's IPv4 allowlist. IPv6 is currently unsupported.

A generation owns its native blueprint, environment and immutable allocation
receipts. Lost once-only submissions are observed rather than posted again.
An explicit refresh cancels superseded work; updates preserve the session deadline.
Stop and expiry abort pending runs, delete the environment and blueprint, and verify
services, jobs, addons, volumes, secret groups and subdomains are absent before
releasing capacity. Uncertain late creation keeps its reservation.

Installation policy must explicitly qualify fixed expiry, same-environment updates, deletion fencing,
restricted runtime-secret delivery and ingress enforcement before admission.
Synthetic fixtures prove controller behavior only. They do not qualify native
expiry timing, cascade deletion, server-side late requests or access protection.

`node --import tsx scripts/qualify-preview-northflank.ts` reports the remaining live
proofs and exits3. It deliberately cannot mark the installation qualified from
source checks. Unknown create outcomes remain cleanup-pending until native
completion can be established; a timeout alone does not release their reservation.

Worker recipes may supply `readiness.command` as an argument array instead of an
HTTP port/path. This becomes a native CMD readiness probe; it runs inside the
application container, and the controller never executes it. An unsuccessful
extension keeps the previous acknowledged deadline and does not promise extra time.


## Installed GitHub controller

The default branch caller accepts new root `/preview` comments and close/reopen/source
notifications. Every event is a hint: the controller rechecks current forge permission,
original unedited human comment, same-project PR, current revision and complete diff.
Forks are ineligible. A push only marks an existing preview stale. Post `/preview start`
for automatic selection or `/preview start chat` for a declared alias. `/preview stop`
begins disposable deletion. `/preview extend 1h` extends the acknowledged deadline by
one hour, at most twice. `/preview status` and `/preview profiles` report state.

Generate reviewable callers with exact commit references:

```sh
devrouter preview init --repo . --integration github \
  --controller-ref <40-character-commit> --policy-ref <40-character-commit> \
  --policy-repository example/private-preview-policy --project app --json
```

Add `--sweeper` for the central five-minute recovery caller, installed once per
installation. `--write` refuses replacement. The npm package includes both templates
and a values-free installation example. Generation is not activation.

Keep installation JSON, reviewed local config/manifest copies and trusted acceptance
code in the private operator repository. Control file SHA-256 fingerprints bind those
copies; candidate files must match at the exact admitted revision. The example's
placeholder digests and acceptance command intentionally fail until configured.
Provider graph settings, resource rates, native network allowlist and runtime secret
references belong to this policy. Candidate code cannot change them.

Inject a JSON map through `DEVROUTER_PREVIEW_CREDENTIALS`, using only scoped
`DEVROUTER_PREVIEW_*` variable names. Native scoped environment variables also work
and take precedence. Credentials are held in memory; malformed map errors suppress
contents. Deployment/state/forge token names cannot be mapped into runtime secrets.
The trusted acceptance command receives generation, revision and public URL map on
stdin, plus only its explicit environment allowlist. It must return JSON with the
same generation/revision/URLs and `ready`, `allowedSource`, `outsideDenied` all true.
Its implementation must exercise the application and both permitted/denied network
sources; returning those flags without that evidence does not qualify an installation.

```sh
devrouter preview doctor --installation /trusted/installation.json --json
devrouter preview state-init --installation /trusted/installation.json --json
devrouter preview handle-event --installation /trusted/installation.json \
  --project app --change 123 --json
devrouter preview sweep --installation /trusted/installation.json --json
```

`doctor` is offline and excludes credential input; exit 3 means qualification is
incomplete. `state-init` is an explicit one-time write. A permanent initialization
witness prevents an accidentally missing pool from being recreated empty. Missing
established state requires operator recovery. The handler reconciles for at most
12 minutes; the independent finite sweep recovers interrupted work. History windows
and authority lookups are bounded; overflow refuses new effects while due cleanup
is still attempted. Keep the sweep scheduled and operational.

The reusable workflow builds an immutable reviewed controller before deployment
credentials are injected, checks out a separately pinned policy repository and uses
Azure OIDC for state access. It checks out no candidate branch. Set the installation's
state token name to `DEVROUTER_PREVIEW_STATE_TOKEN`; map the remaining provider/forge/
runtime names explicitly in the credential secret. Restrict the Azure identity to
the state container and its caller trust. Use a project-scoped Northflank token and
a bot identity with repository read/comment and current-permission lookup access.
The caller declares every secret; it never inherits all secrets. Pin the workflow
and `controller-ref` to the same reviewed commit. Public/private callers must meet
GitHub Actions access policies; self-hosted runners need the declared tool/network
prerequisites. Source templates are unqualified until a fresh live cycle succeeds.
