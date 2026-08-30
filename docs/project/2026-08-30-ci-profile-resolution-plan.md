# Side-effect-free CI profile resolution plan

Date: 2026-08-30. Branch: `rs/ci-profile-resolution` at `origin/main`
`6f4a96f`. Target: `main`. Pull request: none.

## Goal

- Expose Devrouter's existing profile parser, validation, merge, default, and
  wildcard semantics through one stable read-only command that CI and other
  automation can consume.
- Make the result concrete: every selected app, dependency, readiness target,
  managed service, and process is returned as an exact sorted set.
- Use KlickerUZH Playwright CI as the first downstream consumer without making
  Devrouter aware of Klicker package names, test files, or GitHub Actions.

## Non-goals

- Do not start Docker, DevPod, Devsy, Traefik, services, routes, or repository
  processes.
- Do not inspect Git state, read global Devrouter state, write under the home
  directory, use the network, or mutate `.devrouter.yml`.
- Do not add CI-provider-specific output or repository-specific mappings.
- Do not publish a package, push, open or merge a pull request, install a host
  CLI, or integrate another task branch without separate authorization.

## Execution contract

- Execution owner: this main session. The user asked that no new subagents be
  created; planning and implementation remain here.
- Authority: create this plan, edit the isolated worktree, run repository-native
  checks, use a local packed CLI for downstream qualification, and make local
  conventional commits.
- Terminal: the implementation commit is checked and locally committed. After
  the separately approved Devsy `0.0.47` branch lands, one separately approved
  merge-based integration may add shared guidance and prepare `0.0.48`.
- Withheld: rebase, upstream merge, push, PR creation, release publication,
  npm publication, runner-host changes, runner-group changes, and cleanup.
- Pause: shared release or generated-guidance files would overlap the active
  Devsy task; the pure command requires a runtime import; or the output cannot
  be proven without reading values outside `.devrouter.yml`.

## Package boundary and coordination

- Worktree:
  `/Users/rschlae/Git/personal/devrouter/trees/ci-profile-resolution`.
- The active `rs/devsy-agent-preflight` task owns Devsy setup, diagnostics,
  generated guidance, and release `0.0.47`. This branch does not edit those
  seams before that task reaches its local terminal.
- This is an ordinary future PR, not a chained branch. It waits for `0.0.47`
  before release preparation and never rebases the active Devsy branch.
- Downstream plan:
  `klicker-uzh/project/2026-08-30-playwright-profile-runtime-plan.md`.

## Public command contract

Add:

```text
devrouter profile resolve --repo <path> [--profile <selection>] [--json]
```

The command resolves the explicit selection or the configured default. It
returns schema version 1 with these fields:

- `repoPath`: resolved repository path;
- `profile`: canonical sorted profile name;
- `apps`: exact routed app names after profile filtering;
- `dependencies`: exact transitive and explicitly selected dependency names;
- `readiness`: exact routed HTTP apps selected for readiness, expanding the
  documented omitted-readiness default;
- `managedRuntime.baseServices`: exact always-on managed services;
- `managedRuntime.profileServices`: exact selected optional services;
- `managedRuntime.services`: exact union of base and selected services;
- `managedRuntime.processes`: exact selected process markers.

All resource arrays are sorted, unique, and concrete. Wildcards never escape
into this report. Configurations without `managedRuntime` return empty managed
arrays. Invalid, empty, or unknown selections fail before output. JSON mode
writes only JSON to stdout and diagnostics to stderr.

## Security and compatibility

- The command imports only configuration and profile-resolution code. A test
  runs it with no Docker daemon, DevPod, Devsy, Git repository, or writable home.
- Existing `ensure --profile` behavior and internal wildcard representation do
  not change.
- The schema is additive and versioned independently from `.devrouter.yml`.
- The report contains names and a repository path, never environment values,
  credentials, process commands, container metadata, or network responses.

## Test portfolio

| Risk | Acceptance evidence |
| --- | --- |
| Canonical selection | reordered and duplicate merged names produce identical reports |
| Exact expansion | default, merged, route-free, and full wildcard profiles return exact sets |
| Dependency closure | routed and explicit dependencies appear once and unknown entries still fail |
| Readiness default | omitted readiness expands only selected routed HTTP apps |
| Side-effect boundary | command succeeds in a temporary non-Git repo without runtime tools or writable home |
| CLI integrity | JSON stdout parses cleanly; human output and failure stderr remain separate |
| Package integrity | packed CLI exposes the command and resolves a fixture repository |

## Slices

### D0 - Persist this contract

Add this plan and index entry. Check docs policy, knowledge, and diff hygiene.
Commit: `docs(project): plan CI profile resolution`.

### D1 - Add the pure report and command

Add a focused core report builder, thin command handler, lazy CLI registration,
and unit/CLI tests. Do not edit release or Devsy-owned files. Check focused
Vitest, Biome, Knip, typecheck, build, and the package smoke extension.
Commit: `feat(profile): expose side-effect-free resolution`.

### D2 - Reconcile the release boundary

Only after explicit authorization and Devsy `0.0.47` completion, merge its
final branch once, resolve shared documentation deliberately, update the command
inventory and bundled skill, and prepare release `0.0.48`. Never rebase.
Commit: `chore(release): prepare CI profile resolution`.

### D3 - Finish local qualification

Run the full Devrouter checklist except live runtime smokes, which this pure
command does not justify. Pack the CLI and use it against the Klicker fixture.
Record exact results and remaining publication boundary here.

## Progress

- [x] Existing profile and Devsy tasks reported non-overlapping ownership.
- [x] Fresh isolated worktree created from exact `origin/main` `6f4a96f`.
- [x] D0 plan is committed as `024e984`.
- [x] D1 pure command is committed as `384e8a3`, with merged-readiness default
      expansion corrected in `38d417e`. Biome, Knip, typecheck, all 778 unit
      tests, build, and the packed-package smoke pass.
- [x] Public README and repository-onboarding guidance document the
      side-effect-free automation contract without touching Devsy-owned docs.
- [ ] D2 waits for explicit integration authority and completed `0.0.47` work.
- [x] D3 packed CLI contents resolve the real Klicker `manage,pwa`,
      `chat,manage,pwa`, and `live-quiz,manage,pwa` unions with a read-only home;
      full applicable checks pass.
