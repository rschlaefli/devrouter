# devrouter — workspace & agent native

Status: **design v2 — revised post adversarial review; approved to build**. Branch: `feat/workspace-agent-native`.
Target release: **0.0.22**. Last updated: 2026-06-25.

## Review revisions (v2)

Adversarial review found 3 blockers + majors. All resolved in-doc (tagged `R1`–`R8` at the relevant sections):

- **R1** `${WORKSPACE}` is illegal under `UPSTREAM_RE`/`VALID_HOSTNAME_RE` at parse time → add `UPSTREAM_TEMPLATE_RE`
  parse mode for `upstream`; re-validate strict after substitution.
- **R2** `${WORKSPACE}` allowed in `upstream` **only**; **rejected in `host`** (front host auto-namespaced) → kills the
  double-namespace footgun.
- **R3 (B1)** TLS/coverage must see the **runtime (namespaced)** config → load once at command entry, thread down, drop
  inner raw `resolveAppByName`. Without it `*.localhost` doesn't cover `web.<ws>.localhost` → silent TLS failure.
- **R4** explicit compose `-p` **dropped entirely** — Docker's native basename-derived project name already isolates
  distinct worktree dirs, and `dev workspace up` guarantees distinct basenames. No compose-invocation change → no
  orphaned containers, no `name:`/`COMPOSE_PROJECT_NAME` override risk. Same-basename worktrees = unsupported edge.
- **R5** `dev workspace up` passes `devpod up --name <ws>`; one `wsFromBranch()` feeds all three layers → the
  "one token" contract holds by construction (was aspirational).
- **R6** generalize proxy GC into both lazy `evictIfStale` and bulk `evictStaleHostRoutes`; conservative
  positive-confirmation eviction. **R6b** `dev workspace down` frees routes by `workspace` state-filter, never config
  load (works if worktree deleted).
- **R7** add a lock around `writeState` (parallel same-repo runs now common).
- **R8** linked-worktree detection is content-based (`gitdir:` contains `/worktrees/`) → no submodule false-trigger.

Downgraded: route-id `repoPath::name` is safe (distinct paths + namespaced host check) — test only. mkcert leaf
re-issue is non-interactive (CA trusted once) — SAN growth per workspace is fine.

## Why

Agents now work one-isolated-env-per-task: a git **worktree** + its own **devpod/devcontainer**, many in parallel.
devrouter is **multi-repo native, not multi-workspace native**. One `.devrouter.yml` → one host set → N parallel
worktrees of the *same* repo fight for the same `*.localhost` host. Today's guard *blocks* the 2nd
(`HostnameConflictError`, `concurrency.ts:83`). Docs mention worktrees only as a conflict to resolve
(`--keep-config`, GOTCHA #19) — never a first-class mode.

Two collision layers, not one:

1. **Front host** — `web.localhost` is static in config. (hostname collision)
2. **Proxy upstream** — `upstream: myapp-app:3000` is a static devnet alias (`types.ts`, `host-routes.ts:39`).
   N devpod containers all claim alias `myapp-app` on `devnet`. (upstream/alias collision)

Plus a leak: proxy routes are **never** auto-evicted (`concurrency.ts` `evictIfStale` skips proxy) → ephemeral
agent workspaces leak routes forever.

## Goal

Make **workspace** a first-class concept: one **token** identifies an isolated env and parameterizes *all three
layers* with a single identity. Routing follows the workspace automatically. Parallel worktrees + devpods of one
repo coexist with zero manual conflict resolution. Tearing a workspace down reclaims its routes.

Keep devrouter a **router** (non-goal: container orchestrator). The `dev workspace` command is thin, opt-in glue
over devpod + existing primitives — the routing primitives stay standalone.

## North-star alignment (what stays)

- Thin router, container owns env. ✓ keep.
- devnet zero-host-port pattern (`router.ts`, DEVCONTAINER.md). ✓ the foundation we extend.
- Self-describing agent surface (`dev init` prompt, SKILL.md, upgrade prompts). ✓ keep, extend schema.
- Stateless-per-repo, **no global registry** (constraint #3). ✓ preserved (see Identity).

## Design

### The shared-identity contract (the heart of it)

```
devpod workspace name  ==  ws token  ==  ${WORKSPACE}
   (devpod up .)           (devrouter)    ├─ .devrouter.yml  upstream: ${WORKSPACE}-app:3000  → front host  web.<ws>.localhost
                                          └─ devcontainer compose  aliases: [${WORKSPACE}-app]  → devnet alias
```

One token flows: branch/devpod → front host + upstream + compose project + devnet alias. That is "workspace native".

### Token resolution — `resolveWorkspace(repoPath): string | undefined`

Precedence:
1. `--workspace <slug>` flag (run/up/down/status/open/ls/exec/app run).
2. `DEVROUTER_WORKSPACE` env (set & non-empty → use; set & empty → force none, escape hatch).
3. Auto: **linked git worktree** → sanitized branch (`rev-parse --abbrev-ref HEAD`; detached `HEAD` → worktree dir
   basename).
4. primary checkout → **none**.

Linked-worktree detection (**content-based, R8**): `repoPath/.git` is a file → read it → activate **only if** its
`gitdir:` path contains `/worktrees/`. Submodules also use a `.git` file (`gitdir: …/modules/…`) → must NOT activate.
A `.git` directory → primary checkout → none.

`wsFromBranch(branch)` (the lynchpin, **R5**): single deterministic sanitizer → one DNS label
`[a-z0-9]([a-z0-9-]*[a-z0-9])?`, lowercase, `/`+non-alnum → `-`, collapse, cap 32. ALL three layers derive ws from
this same function (devrouter auto-resolve, the `--name <ws>` passed to devpod, the `${WORKSPACE}` substitution), so
they agree by construction.

**Back-compat guarantee:** primary checkout + no env + no `${WORKSPACE}` in config = **byte-identical to today**.
Golden test enforces.

### Derivation rules (R2 — `${WORKSPACE}` is upstream-only)

- **Front host — automatic.** ws active → insert ws label before `.localhost` (`web.localhost`→`web.<ws>.localhost`,
  `db.myapp.localhost`→`db.myapp.<ws>.localhost`). ws absent → bare (today). The front host is **never** templated.
- **`${WORKSPACE}` is allowed ONLY in `upstream`.** `${WORKSPACE}` in `host` is a **parse error** (clear message: the
  front host is auto-namespaced; don't template it). This removes the double-namespace footgun entirely.
- **Substitution** (`upstream` only): ws active → ws. ws absent → **default = `project.name ?? basename(repoPath)`**
  (so `${WORKSPACE}-app` → `myapp-app`, today's alias). Non-empty default required (bare `-app` invalid). Substitute →
  collapse orphan `-` per label → **re-validate** with strict `UPSTREAM_RE`.

### Schema: template token must survive parse (R1)

`parseUpstream`/`UPSTREAM_RE` and `parseHostOrThrow`/`VALID_HOSTNAME_RE` run at **config load**, before
`applyWorkspace`. `${WORKSPACE}` (`$`,`{`,`}`) fails both → `loadRepoConfig` throws today. Fix:
- `upstream`: a value is valid at parse if it is EITHER a concrete `host:port` (strict `UPSTREAM_RE`) OR a template
  matching `UPSTREAM_TEMPLATE_RE` (same but allowing a literal `${WORKSPACE}` token in the host part). Store the raw
  template; the strict check is re-run on the **substituted** value in `applyWorkspace`.
- `host`: reject any `${...}` at parse (per R2). No template parse mode for host.

### `applyWorkspace(config, ws): DevrouterConfig` (in-memory, deep-cloned, never written)

Deep-clone config (no mutation of the loaded object). Per routed app: namespace `host` (auto-insert, if ws);
substitute `${WORKSPACE}` in `upstream` only; docker apps get a **new** `docker.router = sanitize((router ?? name) +
"-" + ws)` so Traefik label keys are unique per ws. Dependency apps: no host, skip. ws absent → returns config with
only the `${WORKSPACE}` default-substitution applied (host bare, router unchanged) = today.

### Single wiring point — load runtime config ONCE, thread it down (R3)

`loadRuntimeConfig(repoPath) = applyWorkspace(loadRepoConfig(repoPath), resolveWorkspace(repoPath))`. **Load once at
command entry and pass the resolved config + app object down** — do NOT let inner helpers re-resolve raw config.
Specifically: `startAppDependencies`/`runConfiguredApp` must stop calling `resolveAppByName` (which loads raw
`loadRepoConfig`) and instead receive the runtime config; the TLS coverage list in `startAppDependencies`
(`app-run.ts:527`) must map the **runtime** config's hosts so the **namespaced** host reaches mkcert. (Without this,
`*.localhost` does not cover `web.<ws>.localhost` → silent TLS cert-name failure — the B1 blocker.) Used by
run/up/down/status/open/ls/doctor/exec. **Write-paths (`app add`/`app rm` file edit) keep raw `loadRepoConfig`** →
committed file always holds the template. (Ties to the comment-preservation fix already landed.)

### Compose project isolation (R4 — rely on Docker's native default, no change)

**No explicit `-p`.** Docker Compose already derives the project name from the working-dir basename, so two worktrees
at distinct dirs (`<repo>` vs `<repo>-<ws>`, guaranteed by `dev workspace up`) already get distinct compose projects +
isolated containers/ports. The overlay cache is keyed on `sha1(repoPath)` (path-unique) too. Adding an explicit `-p`
would either match the default (no gain) or override a user's `name:`/`COMPOSE_PROJECT_NAME` (regression) → so we add
nothing. Same-basename worktrees placed manually is the one unsupported edge (use `dev workspace up --path`).

### New surface — `dev workspace`

- `dev workspace up <branch> [--path <dir>] [--no-devpod] [--open]` — `git worktree add` (if absent) → `ws =
  wsFromBranch(branch)` → optional **`devpod up <path> --name <ws>`** (best-effort, gated on devpod present; **R5** —
  `--name <ws>` forces devpod's workspace name to equal the token so the devcontainer's `${WORKSPACE}-app` alias
  matches what devrouter resolves) → ensure router → `app run` all routed apps → print `https://<app>.<ws>.localhost`.
  Idempotent. Partial-failure: each step is independently re-runnable; on failure print what was/ wasn't done (no
  auto-rollback of `git worktree add`).
- `dev workspace ls` — join `git worktree list` × `wsFromBranch` × live routes (`host-routes-state.json`, filtered by
  `workspace`) × devpod status. One row per workspace.
- `dev workspace down <branch|ws> [--keep-worktree] [--keep-devpod]` — **free routes by reading the state file and
  filtering on `HostRouteState.workspace` — never `loadRuntimeConfig` (R6b)**, so teardown works even if the worktree
  dir / `.devrouter.yml` is already gone → optional `devpod stop` (default; `delete` only with explicit flag) →
  optional `git worktree remove`. The teardown-by-workspace primitive (closes the leak).

Handlers thin; orchestration over existing core fns.

### GC / liveness (gap 3, R6) — REVISED at S3 implementation

Original plan was **upstream-alias liveness**: a proxy route is stale if no running container has its alias on `devnet`
(dockerode network inspect), evicting only on positive confirmation the alias is gone. **Abandoned during S3 real-verify**
— it false-teardowns stable routes. A primary-checkout proxy route fronts a devcontainer that is routinely *stopped*
(you don't run all N projects at once); a stopped-but-restartable devpod is **indistinguishable from gone-forever** at
the alias level, so "alias absent on devnet" wrongly reclaims live, in-use routes. (Empirically proven: a stale build of
the alias-GC reclaimed 16 of 19 real routes whose devcontainers were merely paused.)

Revised signal — **worktree existence** (`evictOrphanedWorkspaceRoutes` in `concurrency.ts`): reclaim a proxy route iff
it carries a `workspace` token AND its `repoPath` (the worktree dir) no longer exists. This is the only *unambiguous*
orphan: the worktree was removed without `dev workspace down`, so nothing can legitimately restore the route. It needs no
docker query, never touches primary-checkout routes (no `workspace` token → not even probed), and never confuses
"paused" with "gone". Wired into the bulk `dev doctor` sweep only (not the per-app `evictIfStale` hot path — proxy
re-registration is already idempotent, so no per-run reclaim is needed). `dev workspace down` still reclaims by
`workspace` filter directly; GC is the safety net for worktrees removed out-of-band.

### Concurrent state writes (R7)

`writeState` (`host-routes.ts`) is read-modify-write with no lock. Parallel same-repo `dev app run` (now the common
case — many agents) can clobber. Add a simple lock around state mutation: `O_EXCL` lockfile with bounded retry, or
atomic write + re-read-merge. Land in S1 (when parallel same-repo runs become real). Pre-existing bug, but the
workspace feature makes it high-probability.

### Identity & constraint #3 (no new registry)

Add optional `workspace?: string` to `HostRouteState` (written at upsert from the resolved ws; sufficient for
teardown **without** loading the config — see R6b). Route id stays `repoPath::name` (path-unique per worktree).
`dev workspace ls` joins the **existing** state file + `git worktree list` — **no new global registry**.
Traefik/`.localhost`/devnet ownership unchanged.

## Slices

### S0 — Foundation (no behavior change, for real)
- `resolveWorkspace(repoPath, override?)` + `wsFromBranch()` sanitizer + **content-based** linked-worktree detection
  (R8: read `.git` file, require `/worktrees/` in `gitdir:`; submodule `/modules/` → none). New
  `src/core/workspace.ts`. No compose change (R4).
- Unit tests: override>env>auto precedence, empty-escape-hatch, linked vs primary vs **submodule** (.git file → not
  activated), branch sanitize (slashes/case/length-cap/trailing-hyphen), detached fallback, all-invalid → undefined.

### S1 — Routing (`applyWorkspace` + wiring)
- Schema (R1): `UPSTREAM_TEMPLATE_RE` accept `${WORKSPACE}` token in `upstream` at parse; **reject `${...}` in
  `host`** (R2). Re-validate substituted upstream with strict `UPSTREAM_RE`.
- `applyWorkspace()` (deep-clone; auto-namespace host; substitute upstream only; new `docker.router` per ws).
- `loadRuntimeConfig()` + **load-once-thread-down** (R3): refactor `runConfiguredApp`/`startAppDependencies` off raw
  `resolveAppByName`; TLS list maps the **runtime** config (B1).
- State-write lock (R7) in `host-routes.ts`.
- Tests: host namespacing, `${WORKSPACE}` default + active, host-template **rejected**, docker router-key uniqueness,
  **TLS list carries namespaced host** (B1 assertion), back-compat golden (primary checkout byte-identical).
- **Verify (real):** two worktrees of one repo, both `dev up`/`app run`, both reachable at distinct `*.localhost` TLS.

### S2 — Lifecycle (`dev workspace`)
- `src/commands/workspace.ts` (`up`/`ls`/`down`) + `cli.ts` registration. `HostRouteState.workspace` field.
- `up` passes `devpod up --name <ws>` (R5); `down` frees routes by **state-file `workspace` filter, not config load**
  (R6b).
- Tests: handler orchestration (mock git/devpod, assert `--name <ws>`), ls join, down-frees-by-ws,
  **down-with-worktree-already-gone still frees routes**.

### S3 — GC (worktree-existence orphan reclaim — see revised GC section)
- `evictOrphanedWorkspaceRoutes()` in `concurrency.ts`: reclaim proxy routes with a `workspace` token whose worktree dir
  is gone. `doctor` reports `routes.orphaned-workspace-routes`. No docker dependency.
- Tests: worktree-present→keep, worktree-gone→evict, primary-route (no ws)→never probed/evicted, host-run ws route→
  ignored (PID liveness owns it).
- **Verify (real):** isolated temp-HOME integration run — orphan (gone worktree) reclaimed, live-worktree + primary
  routes preserved. PASS.
- **Incident note:** during this slice a *stale* `dist/` bundle (old alias-GC, source edited but not rebuilt) was run via
  `dev doctor` against real state and evicted 16 live routes. Lesson: never run a CLI smoke against real/shared state from
  an unrebuilt bundle; destructive-capable verifies go against an isolated `$HOME`. User opted not to restore (routes are
  cheap to re-register on next use).

### S4 — Skill + docs + release
- devcontainer-onboarding: `references/docker-compose.yml` alias → `${WORKSPACE}-app`; `devcontainer.env` default
  `WORKSPACE=<project>`; SKILL.md + GOTCHAS (drop obsolete `--keep-config` hostname-steal #19; add workspace flow);
  `AGENTS-devcontainer.md`.
- Product docs: README, GETTING_STARTED, REPO_ONBOARDING, **PLAN.md (add workspace model as stated design concept)**,
  demo/README, AGENTS.md.
- Agent surface: `ai-prompt.ts` + `.agents/skills/devrouter/SKILL.md` (schema `${WORKSPACE}`, `dev workspace`,
  `DEVROUTER_WORKSPACE`). Run `ai-prompt.test.ts`.
- CHANGELOG `[0.0.22]` + `upgrade-prompts/0.0.22.md`; bump `package.json` + `demo/.devrouter.yml`
  `devrouter.version`.
- **Verify (real):** two devpod worktrees of one repo, `dev workspace up feat-a`/`feat-b` both reachable,
  `down feat-a` clean.

## Tests (vitest, `src/core/__tests__/`)

- `workspace.test.ts` — resolution precedence, sanitize, worktree detection, `applyWorkspace` transforms, `${WORKSPACE}`
  default/active + collapse + revalidate, back-compat golden.
- `docker-run` — `-p` determinism + presence in args.
- `concurrency` — `evictOrphanedWorkspaceRoutes` worktree-existence branches (keep/evict/primary-skip/host-run-skip).
- `commands/__tests__/workspace.test.ts` — up/ls/down handlers (mock spawn).
- Existing suites stay green (back-compat).

## Security review (mandatory pre-merge)

- `${WORKSPACE}` substitution re-validates host (`VALID_HOSTNAME_RE`) + upstream (`UPSTREAM_RE`) → no host injection.
- Branch→ws sanitize blocks hostname injection from branch names.
- `dev workspace` spawns git/devpod **argv-safe** (no shell-string interpolation of branch).
- `--path` worktree dir: same trust as running git locally; document. Compose `-p` value sanitized to `[a-z0-9_-]`.
- No secrets in `dev workspace ls` output.

## Release 0.0.22 (per AGENTS.md checklist)

- `[0.0.22]` CHANGELOG section + `### Agent Adaptation Prompt` → `./upgrade-prompts/0.0.22.md`.
- Upgrade prompt tasks: bump `devrouter.version`; **migration: `dev down` + `docker compose -p <old> down` (or
  recreate) before upgrade** — the `-p` change orphans containers under the old auto-derived project name; optional
  `${WORKSPACE}` adoption in proxy upstreams + devcontainer alias.
- Validation: `check:docs-policy`, `test`, `typecheck`, `build`, `doctor --repo ./demo`, `demo:smoke`.

## Decisions (resolved)

- Framing: **full workspace abstraction up front** (not thin-namespace).
- Upstream: **explicit `${WORKSPACE}` template + default = project name** (visible cross-layer contract).
- Namespace source: **auto from git (linked worktree) + `DEVROUTER_WORKSPACE`/`--workspace` override**.
- Registry: **none** — reuse `host-routes-state.json` + `git worktree list` (constraint #3).
- Process: standalone design doc (this) → review → implement.

## Open (confirm at review)

- Front-host scheme `<app>.<ws>.localhost` vs `<ws>.<app>.localhost` (recommend former; enables future `*.<ws>.localhost`
  per-ws cert).
- `dev workspace up` default worktree path: sibling `../<repo>-<ws>` vs `<repo>/.worktrees/<ws>` (recommend sibling;
  avoids nested-worktree tooling confusion).
- devpod best-effort depth: just `up`/`stop`, or also `delete` on `down` (recommend `stop` default, `delete` opt-in).

## Out of scope (later)

- Per-ws TLS wildcard `*.<ws>.localhost` (single explicit SANs suffice; auto-refresh already covers).
- Scheduled/daemon GC (lazy + `doctor` + `workspace down` enough for v1).
- Non-devpod orchestrators beyond best-effort devcontainer-spec.
- Cross-machine / remote workspaces.

## Sequence

S0 → S1 (+real verify) → S2 → S3 (+real verify) → S4 (+real verify + release). Independent plan review before code;
final-branch review + security review before PR.
