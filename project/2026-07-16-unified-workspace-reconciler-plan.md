# Unified Workspace Reconciler Plan

Status: approved and executing. Implementation not started.

## Research

- User goal: one normal repo command owns local environment reconciliation. Repository wrappers must not orchestrate Devrouter setup, DevPod startup, route registration, TLS repair, and readiness as separate steps.
- Incident: elearning primary checkout ran `devrouter setup`, then `devpod up`, then `repo devcontainer verify --live`. Setup created a cert before repo routes were known. Live verify registered `elearning.klicker.localhost` and `db.elearning.klicker.localhost` without extending SAN coverage. Traefik served its default cert. `curl -k` still passed.
- Code evidence:
  - `src/core/devcontainer-verify.ts` registers one proxy route at a time without `ensureTLSHostsCovered`.
  - `src/core/workspace-ensure.ts` already owns DevPod start/reuse, container proof, TLS coverage, TCP activation, atomic route replacement, HTTP readiness, one bounded recreate, and fail-closed cleanup.
  - `workspaceEnsure` rejects primary checkout at one top-level guard, then assumes linked-only overlay, Git common-dir mount, non-empty workspace env, and workspace-prefixed TCP aliases.
  - `src/core/setup.ts` calls `installTLS()` without configured repo hosts even when `--repo` is supplied.
  - Both live verify and workspace ensure probe with `curl -k`.
  - Primary runtime config already substitutes `${WORKSPACE}` with `project.name`. Elearning therefore resolves `elearning-app:3000` and `elearning-db:5432`, matching its Compose defaults.
  - Existing `devrouter app exec` runs on host with resolved dependency env. It is not DevPod/container exec.
  - Generated managed-process log defaults to `/tmp/devrouter-app.log`, but consumers may override it; elearning uses `/tmp/devrouter-elearning.log`.
- Existing architecture:
  - `docs/adr/0001-repo-local-workspace-ownership.md` scopes durable ownership records to managed linked workspaces.
  - `docs/PLAN.md` explicitly says primary-checkout routes are never touched by workspace GC or teardown.
  - `src/core/devpod-workspaces.ts` already proves exact DevPod ownership by `source.localFolder`.
- Installed DevPod evidence: `devpod ssh` accepts a workspace name/path, `--command`, `--workdir`, and explicit forwarding controls. `--command` is one string, so argv must be POSIX-quoted before crossing that boundary.
- External research: none needed. Local code, installed CLI behavior, existing ADR, real elearning config, and live incident evidence cover current design.

## Plan identity

- Path: `project/2026-07-16-unified-workspace-reconciler-plan.md`
- Type: multi-phase epic; plan lands with Phase A implementation PR, then receives progress updates in Phase B.
- Base: local `main` at `b57315c`
- Phase A branch: `codex/unified-workspace-reconciler`
- Phase A worktree: `trees/unified-workspace-reconciler` (create after plan commit)
- Target: `main`
- Phase A release target: `0.0.32`
- Phase B branch/release target: create after Phase A adoption; expected `0.0.33`
- PRs: none
- History:
  - `project/2026-07-13-workspace-lifecycle-hardening-plan.md`
  - `project/2026-07-14-managed-dev-process-plan.md`
  - `project/2026-07-15-workspace-ownership-cleanup-plan.md`
- ADR: `docs/adr/0001-repo-local-workspace-ownership.md`

## Goal

- Make `devrouter ensure [path]` canonical start/reconcile command for primary checkout and linked worktree.
- Make route publication guarantee router/network readiness, configured TLS host coverage, TCP activation, atomic repo route replacement, and trusted HTTP proof.
- Keep existing `up`/`down` router semantics.
- Add non-destructive `devrouter stop [path]`.
- Add one-shot `devrouter exec [path] -- <command...>` inside exact managed DevPod for tasks such as seed/migrate.
- Reduce consumer startup wrappers to one Devrouter command after one-time machine bootstrap.
- Stage verify semantic cleanup so existing consumers do not lose routes during upgrade.

## Non-goals

- No `.devrouter.yml` v2, environment adapter, logical service target, or Compose generation.
- No ownership of repo install, migrate, seed, or app-start commands. Devcontainer and repo hooks keep these.
- No automatic application command execution during `ensure`.
- No repurpose or rename of top-level `up`, `down`, or binary.
- No global repo registry.
- No primary-checkout record in linked-worktree ledger unless Phase A live evidence proves exact-path DevPod ownership insufficient.
- No primary checkout deletion, GC eligibility, DevPod deletion, or volume deletion.
- No app-log command in Phase A. Current log path is consumer-selected and lacks a stable discovery contract.
- No silent local root-CA trust mutation. First machine bootstrap remains explicit.

## Independent review

- Reviewer: Claude Code, Fable, xhigh, read-only architecture review on 2026-07-16.
- Verified findings:
  - High: route publication has split ownership; live verify omits TLS coverage.
  - High: `curl -k` masks browser-visible TLS failure in both verify and workspace ensure.
  - Medium: `verify --live` mutates route state non-atomically despite verify semantics.
- Accepted:
  - Reframe existing workspace ensure as shared reconciler.
  - Centralize route infrastructure/publication.
  - Use trusted CA and real hostname for readiness.
  - Preserve `up`/`down`; add a new canonical verb.
  - Defer config v2.
  - Treat primary ownership/cleanup as highest-risk seam.
- Main-agent corrections after exact code inspection:
  - One batch route API cannot replace every route path. Host-run routes are published individually after dynamic port discovery; Docker routes are label-owned. Shared module must expose one infrastructure invariant plus batch replacement for proxy route sets.
  - Primary checkout should stay outside linked-worktree ownership ledger by default. Exact-path DevPod ownership already exists and avoids a record-schema migration plus GC risk.
  - Existing `app exec` is not DevPod exec. Add a narrow top-level DevPod exec instead of claiming this use case already exists.
  - Logs remain deferred because managed-process log path is not discoverable across consumers.
- Exact-file review: Claude Fable xhigh, 2026-07-16. Verdict: approve with revisions.
- Accepted required revisions:
  - split root-CA trust installation from routine cert re-mint
  - fail before mutation for mixed routed runtimes in Phase A
  - document intentional live-verify 4xx leniency
  - serialize stop with ensure
  - clarify primary route cleanup wording
- Accepted deliberate deviations: path-owned primary, split route seam, top-level DevPod exec, deferred logs.
- Rejected findings: none. All findings at or above 75% confidence were valid and integrated.

## Decisions

### Product boundary

- Devrouter owns generic local environment reconciliation:
  - exact repo/worktree identity
  - DevPod discovery/start/reuse/one bounded repair
  - shared router files/network/stack
  - TLS host coverage
  - TCP entrypoints
  - proxy route state
  - runtime and route proof
  - non-destructive stop
  - exact DevPod exec
- Consumer repo owns:
  - devcontainer definition and Compose services
  - aliases matching resolved `.devrouter.yml` upstreams
  - local env
  - dependency install
  - migrations/seeds
  - app process command
  - app-specific health behavior

### Command contract

- One-time machine bootstrap: `devrouter setup --repo . --yes`.
- Normal start/reconcile: `devrouter ensure [path] [--open] [--json]`.
- Existing linked command: `devrouter workspace ensure [path]` delegates to same core and remains supported.
- Create linked worktree: `devrouter workspace up <branch> [--open]`.
- Stop current exact environment without deletion: `devrouter stop [path]`.
- Run command inside exact running DevPod: `devrouter exec [path] -- <command...>`.
- Existing `devrouter open`, `status`, `workspace ls --json`, and `app exec` remain.
- `devrouter up`/`down` continue to mean global Traefik lifecycle.

### TLS and probe contract

- `setup --repo` includes current runtime app hosts in `installTLS({ hosts })`.
- `installTLS` remains explicit setup and owns `mkcert -install`.
- Add a separate cert-refresh operation that re-mints with the existing CAROOT/root CA but never installs trust.
- Route infrastructure extends SAN coverage through cert refresh whenever TLS is already enabled.
- TCP proxy routes still require TLS. Missing first-time trust returns one exact setup command; `ensure` does not silently run `mkcert -install`.
- Trusted HTTPS probe:
  - resolve `mkcert -CAROOT`
  - require `rootCA.pem`
  - use `curl --cacert <rootCA.pem>`
  - use actual `https://<host>` URL so SNI and hostname verification run
  - never use `-k`
- HTTP status `100..499` proves routing. `5xx`, TLS error, name mismatch, timeout, missing CA, or connection failure fails.

### Route publication contract

- Add `src/core/route-publication.ts`.
- `ensureRouteInfrastructure` owns router files, devnet, TLS coverage, TCP activation, and router start/restart.
- `replacePublishedProxyRoutes` builds one complete proxy route set and atomically calls `replaceHostRoutesForRepo`.
- Workspace reconciler and Phase A compatibility verify use batch replacement.
- Phase A reconciler supports routed `runtime: proxy` apps only. Any routed `runtime: host` or `runtime: docker` app in the same config fails before infrastructure or route mutation; this prevents repo-wide proxy replacement from deleting a live host-run route.
- `app run` keeps individual route semantics, but uses shared infrastructure preparation. Docker-label routes remain Docker-owned.
- Raw route-state persistence remains in `host-routes.ts`; lifecycle callers do not duplicate TLS/TCP/router preparation.
- Route removal stays allowed without TLS preparation.

### Primary identity contract

- Use discriminated internal target:
  - linked: persisted workspace token, exact DevPod ID, namespace, overlay, Git common-dir mount, workspace env
  - primary: no workspace token or namespace; exact repo path is identity; DevPod ID discovered by exact `source.localFolder`
- Existing exact-path primary DevPod is reused.
- New primary DevPod starts using normal DevPod ID selection, then must be rediscovered as one exact path owner.
- Primary does not call `persistWorkspace` or write `WorkspaceOwnershipRecord`.
- Primary does not appear as GC candidate.
- Primary stop uses exact DevPod path proof, calls provider `stop` only, then removes exact repo routes.
- No command in this plan deletes primary DevPod, checkout, branch, Git metadata, or volumes.

### Compatibility contract

- Phase A keeps `repo devcontainer verify --live --yes` functional.
- Phase A changes it to shared atomic publication plus trusted probe and emits deprecation guidance to `devrouter ensure`.
- Phase A preserves the live-verify JSON schema. Treating HTTP `4xx` as routed is an intentional exit-semantic change from current `curl -f`; document it in the 0.0.32 upgrade prompt.
- Phase B makes live verify read-only only after known consumers and bundled guidance use `ensure`.
- Phase B keeps `--yes` accepted as ignored/deprecated for one release if consumer search finds remaining usage.
- No config migration. Existing v1 workspace ownership records remain byte-compatible.

## Existing consumer and deployment impact

- Production/staging applications, courses, DBs, Payload content, and deployed certs: no effect. Devrouter is local-only.
- Existing primary DevPods: reused by exact path.
- Existing linked worktrees, tokens, ownership records, routes, and volumes: unchanged.
- Existing wrappers using live verify: continue working in Phase A with warning.
- Consumers adopting `ensure`: delete repeated `setup`, direct `devpod up`, Git primary/worktree branching, and live route registration from normal startup wrapper.
- Phase B begins only after repo search and downstream release evidence show no consumer depends on verify mutation.

## Phase A — release 0.0.32

### Slice 1: Trusted route publication

Problem:

- TLS/router/TCP preparation is duplicated across app run, workspace ensure, and live verify.
- Verify mutates per app and omits SAN coverage.
- Readiness ignores certificate trust.

Do:

- Add `src/core/route-publication.ts` with:
  - route infrastructure input derived from full resolved app set
  - router files/devnet/TLS/TCP/router reconciliation
  - atomic proxy route-set replacement
- Move proxy route-input construction from workspace ensure into shared module.
- Replace live verify per-app `removeRouteForApp` + `upsertHostRoute` loop with one batch publish.
- Route app-run infrastructure preparation through shared helper without changing host-run or Docker route ownership.
- Add shared HTTP probe module or helper. One implementation serves workspace readiness and live verify.
- Add mkcert CAROOT/root CA helper in `tls.ts`; fail clearly when TLS enabled but CA unavailable.
- Split TLS operations:
  - explicit setup path runs `mkcert -install`, then mints
  - routine SAN refresh reuses existing CAROOT/root CA and mints only
  - missing/untrusted CA blocks ensure with exact `devrouter setup --repo <path> --yes` remediation
- Make `setup --repo` collect resolved primary/worktree hosts and pass them to `installTLS`.
- Reject any ensure/compatibility-verify config mixing routed proxy apps with routed host/docker apps before route mutation.
- Emit Phase A live-verify deprecation warning on stderr; preserve JSON schema. Record 4xx probe leniency as intentional behavior change.

Files:

- New: `src/core/route-publication.ts`
- New or extracted: `src/core/http-route-probe.ts`
- Change: `src/core/tls.ts`
- Change: `src/core/setup.ts`
- Change: `src/core/app-run.ts`
- Change: `src/core/workspace-ensure.ts`
- Change: `src/core/devcontainer-verify.ts`
- Tests:
  - `src/core/__tests__/route-publication.test.ts`
  - `src/core/__tests__/tls.test.ts`
  - `src/core/__tests__/setup.test.ts`
  - `src/core/__tests__/workspace-ensure.test.ts`
  - `src/core/__tests__/devcontainer-verify.test.ts`
  - `src/core/__tests__/app-run-exec.test.ts`

TDD:

1. Live verify publishes all configured proxy routes in one replacement and requests exact TLS hosts.
2. Trusted probe contains no `-k`, uses CAROOT CA, and rejects bad cert/hostname/5xx.
3. Routine SAN refresh never invokes `mkcert -install`; missing trust points to explicit setup.
4. Setup with repo config installs cert for multi-label hosts.
5. Mixed routed runtime config fails before TLS/router/route mutation and preserves live host routes.
6. Existing app-run and workspace behavior stays green.

Failure/rollback:

- Infrastructure failure occurs before route replacement; old route state remains.
- Mixed runtime rejection occurs before infrastructure mutation.
- HTTP proof failure after replacement removes only exact repo routes.
- TLS refresh preserves existing SANs through current `buildDesiredTLSCertificateHosts`.
- TCP activation may restart router; failure blocks publication.

Check:

- `pnpm exec vitest run src/core/__tests__/route-publication.test.ts src/core/__tests__/tls.test.ts src/core/__tests__/setup.test.ts src/core/__tests__/workspace-ensure.test.ts src/core/__tests__/devcontainer-verify.test.ts src/core/__tests__/app-run-exec.test.ts`
- `pnpm check`
- `pnpm typecheck`
- `pnpm build`
- Static search: no production `curl -k` or `curl -.*k` in route/readiness paths.

Commit: `fix(routing): enforce trusted route publication`

### Slice 2: Reconcile primary checkout through existing engine

Problem:

- Strong reconciler rejects primary checkout.
- Primary uses weaker direct DevPod + verify path.
- Linked-only assertions cannot be blindly applied to primary.

Do:

- Start with live characterization against `examples/devcontainer` and elearning primary checkout:
  - exact DevPod ID/path
  - Compose working dir/config labels
  - repo mount/workspace path
  - default overlay behavior
  - default aliases
  - empty workspace env
  - in-container Git result
- Add internal linked/primary target union.
- Split shared proof from linked-only proof.
- Shared proof:
  - one exact app container for repo path
  - running/healthy state
  - one unique running upstream alias for each container-backed target
  - in-container Git resolves expected checkout
  - trusted route proof
- Reject mixed routed runtimes before primary or linked environment startup; Phase A batch replacement is proxy-only.
- Linked-only proof:
  - persisted token and exact DevPod ID
  - devrouter overlay
  - Git common-dir bind
  - non-empty matching workspace env
  - workspace-prefixed TCP aliases
  - ownership record write/adoption
- Primary-only proof:
  - no workspace namespace
  - resolved upstream aliases use project-name fallback
  - exact-path DevPod selection before/after start
  - no persisted workspace metadata or ownership write
- Preserve one bounded recreate for one already-owned exact DevPod.
- Return `kind: "primary" | "linked"`, optional workspace, exact DevPod ID, URLs.
- Preserve fail-closed exact repo route cleanup after environment mutation.

Files:

- Change: `src/core/workspace-ensure.ts`
- Change only if helper extraction earns it: `src/core/devpod-workspaces.ts`, `src/core/workspace.ts`
- Change: `src/commands/workspace.ts`
- Tests:
  - `src/core/__tests__/workspace-ensure.test.ts`
  - `src/core/__tests__/devpod-workspaces.test.ts`
  - `src/commands/__tests__/workspace.test.ts`
  - `src/core/__tests__/workspace-ownership.test.ts` proves no primary record
  - `src/core/__tests__/workspace-gc.test.ts` proves no primary candidate

TDD:

1. Primary exact DevPod reuse succeeds without workspace persistence/record.
2. New primary start rediscovery returns exact ID.
3. Duplicate exact-path DevPods fail before route mutation.
4. Primary default aliases pass; workspace-prefixed assertions do not run.
5. Primary failure clears exact routes but never stops/deletes checkout or writes ledger.
6. Existing linked tests remain behavior-identical.

Stop condition:

- If live characterization shows primary cannot be proven without persistent ID, pause before schema change.
- Write ADR 0002 only if a primary record becomes necessary. Record must be `kind: primary`, versioned, never GC/down eligible, and backward-compatible with v1 linked records.

Check:

- `pnpm exec vitest run src/core/__tests__/workspace-ensure.test.ts src/core/__tests__/devpod-workspaces.test.ts src/core/__tests__/workspace-ownership.test.ts src/core/__tests__/workspace-gc.test.ts src/commands/__tests__/workspace.test.ts`
- `pnpm check`
- `pnpm typecheck`
- `pnpm build`
- Live cold/warm ensure on `examples/devcontainer`.

Commit: `enhance(workspace): reconcile primary checkouts`

### Slice 3: Canonical ensure and non-destructive stop

Problem:

- Consumer must know primary vs linked flow.
- Current top-level `up` cannot change meaning without breakage.
- Primary lacks a Devrouter-owned stop command.

Do:

- Add `devrouter ensure [path]` with `--open` and `--json`.
- Keep `workspace ensure [path]`; delegate to same command/core.
- Make human output say `Primary checkout` or `Workspace '<token>'`.
- JSON includes `kind`, `repoPath`, optional `workspace`, `devpodId`, `urls`, and whether recreate/TLS refresh occurred when available.
- Add `devrouter stop [path]`:
  - exact path resolution
  - exact DevPod ownership proof
  - provider stop before route removal
  - no-op success when DevPod/routes already absent
  - no delete/GC/worktree mutation
- Take the same per-checkout lifecycle lock as ensure whenever the checkout exists; concurrent ensure/stop cannot interleave provider and route mutations.
- Reuse linked stop implementation where ownership record exists.
- Keep `up`, `down`, `workspace stop`, and `workspace down` behavior unchanged.

Files:

- Change: `src/cli.ts`
- New/change: `src/commands/ensure.ts`, `src/commands/stop.ts`, `src/commands/workspace.ts`
- Change: `src/core/workspace-lifecycle.ts` or narrow new environment-stop core
- Tests:
  - new command tests for ensure/stop
  - `src/core/__tests__/workspace-lifecycle.test.ts`
  - `src/commands/__tests__/workspace.test.ts`
  - `src/commands/__tests__/non-git-compatibility.test.ts`

TDD:

1. Same top-level ensure command handles primary and linked paths.
2. Workspace alias delegates without a second reconciliation path.
3. Primary stop never calls DevPod delete or Git.
4. Stop failure preserves routes.
5. JSON output is stable and contains no secrets.
6. Existing router up/down help and behavior remain unchanged.

Check:

- Focused command/lifecycle tests.
- `pnpm check`
- `pnpm typecheck`
- `pnpm build`
- CLI help/read-back for top-level and workspace commands.

Commit: `enhance(cli): add canonical environment lifecycle`

### Slice 4: Execute one-shot commands inside exact DevPod

Problem:

- Seeding/migration currently requires callers to know DevPod ID and SSH syntax.
- Existing `app exec` runs on host and cannot replace this flow.

Do:

- Add `devrouter exec [path] -- <command...>`.
- Resolve repo path and exactly one DevPod by `source.localFolder`.
- Require running/reachable DevPod. Error points to `devrouter ensure <path>`; exec does not silently start environment.
- Resolve container workspace directory from proven repo mount or use DevPod workspace default only when exact.
- POSIX-single-quote every argv item before passing one `--command` string to DevPod.
- Pass no shell-mode option in v1; caller supplies explicit `sh -lc` as argv when shell behavior is required.
- Disable SSH/GPG agent forwarding for one-shot exec.
- Preserve stdio and child exit code.
- Do not inject secrets or host env.
- Keep `devrouter app exec` unchanged and document distinction.

Files:

- New: `src/core/devpod-exec.ts`
- New: `src/commands/exec.ts`
- Change: `src/cli.ts`
- Tests:
  - `src/core/__tests__/devpod-exec.test.ts`
  - command test for parsing/exit propagation

TDD:

1. Exact primary and linked DevPod selected by path, not guessed ID.
2. Missing/duplicate/stopped DevPod fails with no side effects.
3. Spaces, quotes, dollar signs, semicolons, newlines, and empty argv survive as literal arguments.
4. Agent forwarding is disabled.
5. Exit status passes through.

Check:

- Focused exec tests.
- `pnpm check`
- `pnpm typecheck`
- `pnpm build`
- Live: `devrouter exec ./examples/devcontainer -- node -e <literal-argv-proof>`.

Commit: `feat(exec): run commands in managed DevPods`

### Slice 5: Guidance, release, and downstream proof

Do:

- Update required current-state docs:
  - `README.md`
  - `AGENTS.md`
  - `docs/GETTING_STARTED.md`
  - `docs/DEVCONTAINER.md`
  - `docs/REPO_ONBOARDING.md`
  - `docs/PLAN.md`
  - `examples/routing/README.md`
  - `examples/devcontainer/README.md`
  - `examples/workspace/README.md`
- Update generated guidance:
  - `.agents/skills/devrouter/SKILL.md`
  - `src/core/ai-prompt.ts`
  - matching tests
- Guidance rule:
  - one-time: setup
  - normal: ensure
  - never branch manually on primary vs linked
  - never use live verify as startup
  - use exec for container commands
- Update examples/smokes:
  - primary devcontainer smoke uses `ensure`
  - trusted curl has no `-k`
  - linked lifecycle smoke remains
- Reword primary safety guarantee in `docs/PLAN.md`: GC and `workspace down` never touch primary routes/checkouts; explicit `ensure`/`stop` on that exact checkout may replace/remove its routes.
- Release `0.0.32`:
  - package/example versions
  - changelog
  - exactly one `upgrade-prompts/0.0.32.md`
  - prompt tells consumers to replace setup + DevPod + verify wrappers with ensure
- Downstream elearning after release:
  - bump required Devrouter version
  - reduce `scripts/dev-up.sh` to prerequisite check plus `devrouter ensure "$REPO_PATH"`
  - remove direct DevPod and Git primary/worktree branching
  - use `devrouter exec` for seed fixture setup

Full check:

- `pnpm check:docs-policy`
- `pnpm check`
- `pnpm knip`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `opengrep scan --config auto`
- `pnpm routing:smoke`
- `pnpm devcontainer:smoke`
- `pnpm devcontainer:smoke down`
- `pnpm workspace:lifecycle-smoke`
- `npm pack --dry-run`

Live acceptance:

1. Clean machine-state gate: setup with repo exact hosts; doctor reports no TLS host-coverage warning.
2. Primary cold ensure: one exact DevPod, correct default aliases, all routes, trusted HTTPS, healthy TCP.
3. Primary warm ensure: same DevPod/container/process; no duplicate routes.
4. Linked cold/warm ensure: namespace/env/overlay/common-dir/aliases/routes all agree.
5. Stop: DevPod stopped, exact routes removed, checkout/record/volumes retained.
6. Exec: run harmless argv proof and downstream seed command inside exact DevPod.
7. Elearning browser gate after user-owned start:
   - no certificate warning at `https://elearning.klicker.localhost`
   - course/unit with duplicate block titles loads
   - distinct PDF navigation entries open distinct PDF content
   - warm ensure preserves runtime
8. Verify compatibility: old live-verify command still succeeds, warns, uses trusted cert, and publishes atomically.

MR evidence:

- Terminal transcript summary for cold/warm primary and linked runs.
- Exact cert/SAN and trusted-curl proof.
- Stable ensure JSON example.
- Downstream wrapper before/after.
- Elearning browser screenshot/comment belongs in downstream PR, not Devrouter PR.

Commit: `chore(release): publish 0.0.32 unified reconciliation`

## Phase B — read-only verification, expected release 0.0.33

Adoption gate:

- Search known consumer repos, bundled skill, AI prompt, examples, upgrade prompts, and docs for `repo devcontainer verify --live`.
- Confirm supported startup paths use `ensure`.
- Confirm Phase A release and downstream elearning gate are complete.
- If unknown consumers remain, keep compatibility for another release.

### Slice 6: Make live verify read-only

Do:

- Remove route publication from `src/core/devcontainer-verify.ts`.
- Live verify reads existing exact repo route state and compares name, host, protocol, upstream host/port, and workspace.
- Probe existing HTTP routes with shared trusted probe.
- Report TCP route presence plus current read-only upstream evidence available from doctor/container inspection.
- Missing/mismatched route is error with `devrouter ensure <path>` suggestion.
- Remove `--yes` requirement. Accept ignored deprecated flag for one compatibility release if adoption search requires it.
- Product docs describe current read-only semantics only.
- Changelog/upgrade prompt carry migration history.
- Release `0.0.33`.

Files:

- `src/core/devcontainer-verify.ts`
- `src/commands/repo-devcontainer.ts`
- `src/cli.ts`
- `src/core/__tests__/devcontainer-verify.test.ts`
- `src/commands/__tests__/repo-devcontainer.test.ts`
- required docs/skill/AI prompt/changelog/upgrade prompt
- this plan Progress update

TDD:

1. Live verify performs zero route-state writes.
2. Matching existing route passes.
3. Missing/stale/mismatched route fails with ensure remediation.
4. Trusted cert failure fails.
5. JSON evidence distinguishes configured, registered, and reachable.

Check:

- Focused verify tests.
- Full validation and both smoke suites.
- Static search proves no verify code imports route mutation.
- Independent consumer migration read-back.

Commit: `refactor(verify): make live checks read-only`

Release commit: `chore(release): publish 0.0.33 read-only verification`

## Deferred work

- Config v2/environment adapter/logical targets: defer until lifecycle contract has adoption evidence. Current Compose aliases remain explicit source of truth.
- App logs: define discoverable log contract first. Do not assume `/tmp/devrouter-app.log`.
- `dev` binary alias: separate naming decision.
- Automatic root-CA trust from ensure: keep explicit consent boundary.
- DevPod provider abstraction beyond current exact local provider: separate design.
- General Docker/DevPod passthrough: rejected.

## Risk register

| Risk | Guard |
| --- | --- |
| Primary proof differs by consumer devcontainer | Live characterization before code; shared vs linked-only assertions |
| Primary enters GC/destructive lifecycle | No primary record; exact-path stop only; tests assert no delete/Git mutation |
| Route state changes before TLS/runtime ready | Infrastructure/proof first; one atomic replacement |
| Mixed host/proxy config loses live host route | Phase A rejects mixed routed runtimes before mutation |
| Cert refresh hides hostname error | Trusted CA plus actual hostname/SNI; no `-k` |
| SAN refresh mutates trust store | Only explicit setup runs `mkcert -install`; routine refresh re-mints only |
| Router restart fails during TCP activation | Block publication; preserve old state |
| Verify semantic change breaks wrappers | Phase A compatibility release; Phase B adoption gate |
| DevPod exec shell injection | Quote every argv item; explicit tests; no implicit shell flag |
| Exec forwards host credentials | Disable SSH/GPG agent forwarding |
| Scope expands into repo lifecycle | Repo keeps install/migrate/seed/start; Devrouter only invokes explicit exec |
| Log UX assumes scaffold detail | Logs deferred |

## Skill routing during implementation

- `$rs-sliced-development-workflow`: plan ownership, slice cadence, reviews, commits, PR.
- `$tdd`: public CLI/core behavioral tests before each implementation step.
- Per slice: independent correctness review, separate simplification review, then fresh verification.
- Final: `$security-review`, `$thermo-nuclear-code-quality-review`, independent whole-branch review.
- `$rs-mr-description-writer`: Phase A and Phase B PR bodies.
- `$rs-compound`: update existing DevPod/workspace identity solution after verified live lesson.

## Progress

- Done: reproduced and diagnosed elearning TLS failure.
- Done: inspected elearning primary/worktree wrapper, config, aliases, overlay, and managed process.
- Done: inspected Devrouter route, TLS, setup, verify, workspace ensure, ownership, lifecycle, exec, logs, docs, and tests.
- Done: Claude Fable xhigh architecture review completed against clean `main@b57315c`.
- Done: accepted invariant seam, trusted probe, primary reconciliation, command compatibility, and config-v2 deferral.
- Done: corrected primary-ledger, DevPod-exec, and log-path assumptions from exact code.
- Done: exact-file Claude Fable review completed; two blockers and three clarifications integrated.
- Done: Fable accepted path-owned primary, split route seam, top-level DevPod exec, and deferred logs.
- Done: user approved Phase A implementation on 2026-07-16.
- Active: commit approved plan alone, then create repo-local implementation worktree.
- Next: Slice 1 trusted route publication.
- Implementation: not started.

## Approval

- Phase A approved by user on 2026-07-16.
- Phase B remains adoption-gated and needs fresh approval after Phase A evidence.
- Push, PR, merge, npm publish, and downstream elearning edits remain separately approval-gated.
