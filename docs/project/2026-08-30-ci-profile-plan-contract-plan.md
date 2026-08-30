# CI profile-plan contract and Klicker adoption plan

Date: 2026-08-30. Devrouter branch: `rs/ci-profile-plan-contract` from
`origin/main` `865fe89bff6de53bd47be66cddce643678c70055`. Target:
`main`. Klicker consumer branch: `rs/playwright-ci-profiles`, pull request
[#5683](https://github.com/uzh-bf/klicker-uzh/pull/5683), target `v3`.

## Goal

- Add one runtime-side-effect-free Devrouter command that resolves a profile,
  validates it against a strict repository-owned CI contract, and emits exact
  literal bindings for a consumer launcher.
- Release that command as `@devrouter/cli@0.0.51` and replace Klicker's
  duplicated app-to-Turbo/readiness planner in the existing draft pull request.
- Preserve the public runner trust boundary, current runner cost, hosted
  fallback, restore-only caches, shard assignment, and GitHub runner-group
  policy.

## Non-goals

- Do not make Devrouter understand Playwright, Turbo, GitHub Actions, Klicker
  package names, runner groups, shards, test files, or service containers.
- Do not start Docker, DevPod, Devsy, Traefik, applications, routes, or runner
  hosts from the new command.
- Do not move spec-to-profile assignment, timing-aware sharding, workflow
  permissions, service-container declarations, or runner eligibility into
  Devrouter.
- Do not add dependencies, change runner capacity, modify runner hosts or
  organization settings, expose secrets, or allow fork pull requests.
- Do not rebase either package or modify the unrelated stale
  `docs/chatbot-hitl-config-roadmap` branch.

## Execution contract

- Execution owner: this main session. The user explicitly asked for no
  subagents, so planning, implementation, simplification, and review stay in
  the main session. Every required gate is recorded with direct diff and test
  evidence.
- Boundary owner: self.
- Authority: create and edit the two isolated task worktrees; make scoped local
  commits; push the Devrouter branch; open and maintain its pull request; merge
  it when exact-head checks, comments, threads, and mergeability are safe;
  publish and verify `@devrouter/cli@0.0.51`; update and push the existing
  Klicker draft; merge current `origin/v3` into that branch once without
  rebasing when it is otherwise ready; mark the draft ready; merge it when safe;
  and inspect the first eligible post-merge public Playwright run.
- Withheld: force push, protected-branch direct push, runner-host mutation,
  runner-group mutation, secrets, deployments, unrelated pull-request changes,
  retries without a diagnosed failure, worktree deletion, and branch deletion.
- Terminal: Devrouter `0.0.51` is published from its verified merge commit;
  Klicker consumes that exact package in merged `v3`; the runner policy remains
  unchanged; and an eligible exact-head run either proves the named public
  ARM64 runners and all eight Playwright artifacts or records `delivery_pending`
  because no safe trigger exists.
- Pause: the contract cannot remain repository-neutral; the public command
  would need shell evaluation or runtime access; exact-head CI exposes a new
  trust-boundary defect; release provenance cannot be established; or current
  target drift materially conflicts with either package.

## Plan identity and continuity

- Devrouter plan:
  `docs/project/2026-08-30-ci-profile-plan-contract-plan.md`.
- Historical Devrouter profile resolver:
  `docs/project/2026-08-30-pr-47-ci-profile-resolution-plan.md`.
- Active Klicker consumer plan:
  `project/2026-08-30-playwright-profile-runtime-plan.md`.
- Devrouter uses its established `docs/project/` artifact root. Klicker keeps
  its established `project/` root; no second artifact root is created.
- The Klicker follow-up guard is satisfied by widening the existing draft
  [PR #5683](https://github.com/uzh-bf/klicker-uzh/pull/5683), not by opening a
  second consumer pull request.

## Research and evidence

- Evidence: Devrouter `0.0.50` already exposes deterministic
  `profile resolve` output for apps, dependencies, readiness, managed services,
  and managed processes without importing runtime orchestration.
- Evidence: Klicker's current adapter repeats a seven-app mapping, managed
  resource policy, canonicalization, output writing, and profile-report
  validation in `util/playwright-profile-runtime.mjs`.
- Evidence: spec-to-profile assignment and eight-shard planning are
  repository-specific and already have a stable tested seam in
  `.github/scripts/get-shard-files.js` and `playwright/profiles.json`.
- Evidence: exact-head [PR #5683](https://github.com/uzh-bf/klicker-uzh/pull/5683)
  currently fails during installation because `cpu-features` and `ssh2` build
  scripts are neither approved nor explicitly ignored under the repository's
  pnpm build policy. All observed check, hosted Playwright, and GraphQL failures
  share this cause and occur before product tests.
- Decision: no external research is needed for the contract design. The
  authoritative evidence is the current Devrouter command, current consumer
  adapter, repository package policy, and exact GitHub Actions logs.
- Limitation: the draft branch cannot prove its self-hosted reusable workflow
  before merge because the caller and runner group deliberately allow only the
  exact workflow on `refs/heads/v3`.

## Primitive impact

| Product primitive | Disposition | Contract delta | Compositions and consumers | Evidence or ruling |
| --- | --- | --- | --- | --- |
| Devrouter profile selection | Reuse | None; profile parsing, defaults, merge, wildcards, and exact resources remain schema version 1 | Local managed runtimes and automation | Existing `profile resolve` implementation and tests |
| Automation profile plan | Create | A versioned repository-owned contract maps selected app identities to named literal binding arrays and constrains all selected resource dimensions | Klicker Playwright CI first; other repositories later | User approved moving reusable planning into Devrouter while retaining repository ownership |
| Repository CI launcher | Compose | It consumes literal bindings as argv and readiness inputs; it still owns commands, tests, workflow policy, and failure reporting | Hosted and public Klicker Playwright workflows | Existing consumer adapter and runner trust contract |

## Architecture decision and ADR gate

- Decision: Devrouter owns profile resolution, strict contract parsing,
  resource-policy validation, deterministic literal-binding aggregation, and
  optional atomic output. A consumer repository owns the contract values and
  the launcher that interprets each binding key.
- Decision: the contract is a separate repository file supplied explicitly to
  `profile plan`; it does not expand `.devrouter.yml` with CI-provider or build
  tool concepts.
- Decision: bindings are arrays of literal strings. Devrouter never executes,
  interpolates, templates, or shell-parses them.
- Rejected: returning app host/upstream definitions is insufficient because
  local managed-runtime addresses differ from CI localhost readiness and do not
  identify repository build packages.
- Rejected: embedding commands in `.devrouter.yml` would mix local runtime
  identity with consumer-specific automation and encourage Devrouter to become
  a workflow engine.
- ADR gate: passed. This establishes a public integration boundary that is
  costly to reverse, surprising without its ownership rationale, and chosen
  over two viable alternatives. Slice D1 records ADR 0007 and links it from the
  project index.

## Public command contract

Add:

```text
devrouter profile plan --repo <path> --profile <selection> \
  --contract <repo-relative-yaml> [--output <path>] [--json]
```

- The command first builds the existing schema-version-1 profile resolution
  report. It then reads one strict version-1 contract from inside the resolved
  repository, rejecting lexical or real-path escape and non-regular files.
- The contract requires selected apps to be non-empty when requested, maps each
  allowed app to one or more named arrays of literal strings, and applies
  `allowed` policies to dependencies and managed services plus an `exact`
  policy to managed processes.
- Every selected app must have exactly one mapping. Unknown resource names,
  unknown keys, duplicate entries, empty strings, unsupported selected
  resources, empty required app selections, and unsupported schema versions
  fail before output.
- Binding keys use a conservative identifier syntax. Binding arrays preserve
  per-mapping declaration order, aggregate apps in canonical profile order, and
  remove later duplicates by first occurrence. Profile resource arrays retain
  the current sorted canonical form.
- The JSON plan contains the original exact profile resources plus
  `contractPath` and a `bindings` object. The command does not attach command
  semantics to binding keys.
- `--json` writes only JSON to stdout. `--output` atomically writes the same JSON
  with mode `0600` and may be combined with JSON or human output. Diagnostics
  remain on stderr.
- Contract input and produced output are bounded. Oversized files, excessive
  mappings, excessive binding keys, or excessive total literal values fail with
  actionable errors instead of consuming unbounded memory.

## Security and compatibility

- Runtime side effects remain impossible from the profile-plan code path. It
  imports only profile/config parsing, contract parsing, path validation, and
  atomic file output.
- Contract strings are data. Devrouter does not use a shell, environment
  expansion, template expansion, command substitution, dynamic import, or
  `eval`.
- The contract may be changed by public pull-request code, but the public runner
  already executes that untrusted repository code. It still receives no
  secrets, private source, privileged Docker socket, or private-network access.
- The Klicker launcher validates the expected binding keys and literal shapes,
  passes Turbo filters as distinct argv entries, and accepts only loopback HTTP
  readiness URLs. It no longer carries app-to-package or app-to-endpoint maps.
- `profile resolve`, `.devrouter.yml` schema version 1, existing managed-runtime
  behavior, and every current command remain backward compatible.
- The runner group stays restricted to the Klicker repository and
  `.github/workflows/public-pr-playwright-shards.yml@refs/heads/v3`.

## Delegation map

| Workstream | Slices | Owner | Dependency | Acceptance boundary |
| --- | --- | --- | --- | --- |
| Generic contract | D0-D2 | main | Current Devrouter `origin/main` | Packed CLI emits and atomically writes a validated generic plan without runtime tools |
| Devrouter delivery | D3 | main | D0-D2 green | Exact merge commit publishes npm `0.0.51` with provenance and isolated install proof |
| Klicker adoption | K1-K2 | main | Published `0.0.51` | Existing draft uses the generic plan, has no duplicated app mapping, and passes local plus exact-head CI |
| Runner proof | K3 | main | Klicker merged to `v3` | Eligible run names public runners, schedules eight shards, uploads eight artifacts, and passes aggregate status |

Execution-tier skip reason: critical-path coupling and the user's explicit
no-subagent instruction keep every slice in the main session.

## Test portfolio

| Consequential behavior or risk | Existing evidence | Test obligation | Primary seam | Distinct failure caught | Slice |
| --- | --- | --- | --- | --- | --- |
| Existing profile semantics remain unchanged | `profile-resolution.test.ts` | Extend existing | Core report builder | Plan path accidentally changes defaults, merges, readiness, or wildcard expansion | D1 |
| Strict generic contract and deterministic bindings | None | Add new | Pure contract-to-plan builder | Unknown app, resource widening, duplicate/empty literal, or unstable aggregation is accepted | D1 |
| Repository boundary and bounded input | Existing lexical path helper only | Add new | Contract loader | Symlink escape, non-file input, or oversized input is read | D1 |
| No runtime or shell side effects | Existing resolver non-Git CLI/package proof | Extend existing | CLI integration in isolated temporary repository | Runtime import, shell execution, or global-state dependency enters the command | D1-D2 |
| Secure output | Existing atomic file helper | Add new | CLI output integration | Output is partial, follows a target symlink, or is not mode `0600` | D1 |
| Installed package exposes the command | Existing package smoke | Extend existing | Packed isolated install | Source tests pass but distributed CLI omits or breaks `profile plan` | D2 |
| Klicker launcher accepts only expected literal bindings | Current adapter unit tests | Replace/consolidate | Thin consumer launcher | Unexpected key, unsafe Turbo argument, or non-loopback endpoint reaches startup | K1 |
| Every active Playwright spec stays assigned once | Current shard planner tests | None | Existing planner test | Missing/stale spec assignment or shard duplication | K1 |
| pnpm build-script policy is explicit | Exact-head install failure | Add no new test | Frozen install | Optional Devrouter transitive scripts block every CI job | K1 |
| Hosted and public workflows stay equivalent and locked down | Current YAML and policy evidence | Extend existing static verification | Workflow diff plus runner-group readback | Consumer migration changes permissions, cache writes, labels, or reusable workflow path | K2 |
| Real self-hosted behavior | No pre-merge public proof possible | Add no test | Post-merge exact workflow run | Static plan is correct but runners do not schedule, start, or upload all artifacts | K3 |

## Slices

### D0 - Persist the cross-repository contract

- Route: main.
- Do: add this plan and the Devrouter project-index entry. Record the current
  exact bases, PR failure evidence, architecture boundary, delivery topology,
  test portfolio, authority, and progress.
- Check: docs policy, knowledge check, Markdown formatting, status, and exact
  diff inspection.
- Commit: `docs(project): plan CI profile bindings`.

### D1 - Emit generic literal bindings from resolved profiles

- Route: main.
- Do: add the strict contract parser, versioned plan builder, bounded
  repository-path loader, CLI handler and registration, optional atomic output,
  focused core/command tests, and ADR 0007. Reuse the existing profile report
  rather than adding a second profile parser.
- Check: focused profile/contract/command tests, Biome, Knip, typecheck, and
  build. Prove a temporary non-Git repository succeeds without Docker, DevPod,
  Devsy, Traefik, writable home state, or network.
- Commit: `feat(profile): emit repository-owned CI bindings`.
- Slice review: main-session correctness, security, architecture, and
  simplification pass because subagents are explicitly disabled.

### D2 - Document and package the reusable contract

- Route: main.
- Do: update current command inventories, repository onboarding, README,
  generated agent guidance, bundled Devrouter skill, package smoke, knowledge
  authority, and examples needed to make the contract reusable without
  mentioning Klicker-specific values as the generic contract.
- Check: docs policy, knowledge validation, focused prompt/guidance tests,
  package smoke, full test suite, build, and packed CLI proof against a generic
  fixture. K1 supplies the later proof against Klicker's real consumer contract.
- Commit: `docs(profile): document CI binding contracts`.

### D3 - Release Devrouter 0.0.51

- Route: main.
- Do: prepare the exact `0.0.51` release artifacts under the repository release
  checklist, run the complete applicable validation set, inspect the full diff
  for secrets and unrelated changes, push the branch, open the conventional
  pull request, monitor exact-head checks and feedback, merge when safe, publish
  the GitHub release, and verify npm metadata, integrity, shasum, provenance,
  and a fresh isolated install/profile-plan smoke.
- Check: exact PR head and merge commit; successful CI and publish jobs; npm
  `latest` equals `0.0.51`; packed and registry artifacts resolve to the same
  verified package; fresh CLI emits the expected generic plan.
- Commit: `chore(release): prepare CI profile bindings`.

### K1 - Replace Klicker's planner with the released contract

- Route: main.
- Do: add the repository-owned Playwright binding contract; update the existing
  launcher to invoke `devrouter profile plan`; delete the app-to-package,
  app-to-endpoint, and managed-resource policy maps; retain only schema/key and
  literal-shape validation plus argv launch/readiness consumption. Pin exact
  `@devrouter/cli@0.0.51`, update `.devrouter.yml` metadata, and explicitly
  ignore the optional `cpu-features` and `ssh2` install scripts in pnpm policy.
- Check: frozen install, focused launcher tests, every profile union, all eight
  shard plans, package build prerequisites, and diff hygiene. The selected
  process-count result must remain 45 rather than the previous fixed 72.
- Commit: `refactor(ci): consume Devrouter profile bindings`.

### K2 - Qualify and deliver the widened Klicker draft

- Route: main.
- Do: update the active Klicker plan, testing/CI wiki, and Playwright skill;
  verify both workflows still use one consumer path; merge current `origin/v3`
  once without rebasing when the branch is otherwise green; rerun affected
  checks; push [PR #5683](https://github.com/uzh-bf/klicker-uzh/pull/5683);
  update its whole-branch description; mark ready; monitor exact-head CI,
  comments, reviews, threads, and mergeability; merge when safe.
- Check: local Node 24 focused tests, YAML parsing, complete repository checks,
  staged secret scan, substantive-size report, exact-head required checks, and
  unchanged runner-group policy readback.
- Commit: `ci(playwright): use reusable profile plans` plus a separate plan
  progress commit when required by the active plan contract.

### K3 - Prove real public runner execution

- Route: main.
- Do: follow the first safe eligible same-repository pull-request run that uses
  the merged `v3` reusable workflow. Do not mutate an unrelated pull request to
  create a trigger. Compare its runner names, startup summary, process count,
  shard scheduling, artifact set, aggregate status, and critical-path timing
  with the recorded baseline.
- Check: exact head and workflow ref; public route selected; actual
  `public-pr-arm64-01` through `-08` names as scheduled; eight shard artifacts;
  passing `test-playwright-status`; hosted fallback remains available for
  ineligible cases.
- Commit: no source commit. Record live evidence in the Klicker plan and PR or
  report `delivery_pending` when no eligible safe trigger exists.

## Manual and pull-request evidence

- Devrouter PR URL, exact head, merge commit, release URL/workflow, npm shasum,
  integrity, provenance, and isolated plan output.
- Klicker [PR #5683](https://github.com/uzh-bf/klicker-uzh/pull/5683) exact head,
  full changed-path set, substantive size, all check results, runner-group
  readback, and merge commit.
- First eligible public-run proof with exact workflow run, named runner per
  shard, profile summary, selected process count, eight artifacts, aggregate
  status, and timing comparison.

## Planning-stage review

- Planning specialist: not dispatched because the user explicitly prohibited
  subagents. The main session reviewed the plan against the current Devrouter
  resolver and package/release rules, current Klicker adapter and workflow
  boundary, exact GitHub Actions failures, product-primitive ownership, ADR
  gate, and the full-path test/authority requirements.
- Accepted correction: the immediate Klicker CI failures are one explicit pnpm
  optional-build policy defect, not three independent code failures.
- Accepted correction: the generic contract emits named literal arrays but
  never owns command prefixes or interprets binding keys.
- Accepted correction: the consumer remains in the existing draft PR to avoid
  a packaging-boundary miss and to keep pre-merge proof limitations explicit.

## Progress

- Status: active; D0-D2 are complete and D3 is next.
- Completed: authoritative remote refresh; fresh Devrouter worktree from exact
  `origin/main`; current Devrouter resolver, release process, current Klicker
  adapter, runner policy, and exact-head PR failure logs inspected; plan and
  project index pass docs policy, knowledge validation, and diff checks.
- Completed: D1 adds the strict version-1 contract, deterministic literal
  binding aggregation, bounded repository loader, CLI registration, secure
  optional output, focused tests, and ADR 0007. Focused verification passes 18
  tests; Biome, Knip, typecheck, and build also pass under Node 24.
- Completed: D2 documents the version-1 contract in current manuals, knowledge,
  generated guidance, and the bundled skill. The packed tarball succeeds from a
  non-Git fixture with a non-writable home, no runtime tools, matching stdout and
  mode-`0600` file output. The full Vitest suite passes 840 tests across 71 files;
  the Linux-only process harness reports its expected macOS skip.
- Remaining: D3 and K1-K3.
- Latest evidence: Devrouter baseline is `0/0` against `origin/main` at
  `865fe89`; [PR #5683](https://github.com/uzh-bf/klicker-uzh/pull/5683) is
  mergeable at `b882312524ce4627494ba35c97cfcab43a7882d2` and fails all three
  affected jobs during pnpm installation on the same unclassified optional
  build scripts.
- Review gates: main-session plan review and D1-D2 correctness, security,
  architecture, and simplification review are complete. The D1 review hardened
  own-property handling against prototype-sensitive resource names, added
  unknown-resource and mapping-limit coverage, and found no runtime-control or
  shell-evaluation path. The D2 review keeps all examples repository-neutral,
  states consumer ownership explicitly, and proves the installed package rather
  than the source entry point. Later slice and integrated reviews remain
  required under the no-subagent execution exception.
- Required delivery layer: published Devrouter package, merged Klicker source,
  and live public-runner proof when a safe eligible trigger exists.
- Achieved delivery layer: complete locally committed D1 plus locally verified
  D2 documentation/package work; Klicker remains a draft PR.
- Local verification note: Homebrew Bash 5.3 deadlocked while writing the
  package smoke's pre-existing first heredoc, before producing any fixture file;
  macOS system Bash completed the unchanged smoke. The `pnpm test` wrapper ran
  all 840 Vitest cases, then its nested host `pnpm` resolved 11.24.0 instead of
  the pinned 11.6.0; the pinned process command was run separately and reached
  its expected Linux-only skip.
- Next action: commit D2, prepare the exact 0.0.51 release artifacts, and run
  the full release gate.
