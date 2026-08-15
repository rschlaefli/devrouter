# W1 execution plan — packaged CLI command proof

## Identity and scope

- Date: 2026-08-15.
- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Branch: `rs/packaged-cli-command-proof`.
- Worktree: `/Users/rschlae/Git/personal/devrouter/trees/rs-packaged-cli-command-proof`.
- Target: `main`, based on `f37fc030d602afe22805f7c51c448d6d4079830f`.
- Parent roadmap: [Devrouter roadmap](./2026-02-07-devrouter-roadmap.md).
- Package roadmap: [Packaged CLI command and release proof](./2026-08-15-packaged-cli-command-release-proof-roadmap.md).
- Related backlog: [Open-source release plan](./2026-02-08-open-source-release-plan.md).
- Pull request: not created yet.

This plan adds a local package-boundary integration smoke, requires it in the
existing CI check job, and synchronizes the owning verification guidance. It
does not change product command behavior, add dependencies, publish a package,
bump a version, or perform live Docker, DevPod, TLS, setup, or cleanup work.

## Ceremony and review routing

This is the full development path because the change introduces a maintained
distribution-boundary test harness, changes a required CI gate, and carries a
named packaging risk. The implementation is still deliberately two slices:

1. Package smoke harness and its local command entry point.
2. CI enforcement and current-state verification guidance.

No product-primitives or ADR decision is needed: the package smoke exercises
existing non-mutating commands and introduces no product contract.

The planner pass was performed before this plan was written. Its required
corrections are captured below and in the slice acceptance criteria. S1 is an
eligible bounded executor task with a disjoint write set. S2 stays in the main
session because CI and the owning documentation are a small, critically
coupled integration. The main session owns integration, commits, final
verification, and any external GitHub action.

## Research and baseline

### Repository facts

- `package.json` publishes `bin`, `dist`, and `upgrade-prompts`; it declares
  `devrouter -> dist/devrouter.js` and `devrouter-process ->
  bin/devrouter-process`.
- `pnpm build` produces the single CLI bundle consumed by the package.
- `.github/workflows/ci.yml` currently runs `pnpm build` as the last step of
  the required `check` job. The conditional `publish` job must remain
  unchanged.
- `examples/routing/.devrouter.yml` is an existing non-mutating probe fixture
  pinned to the current package version, so `upgrade --repo` should report no
  newer target while still proving packaged prompt discovery.
- `src/core/upgrade.ts` includes a `process.cwd()/upgrade-prompts` fallback.
  A repository-local invocation can therefore hide a missing packaged prompt
  directory; the smoke must run from a temporary cwd outside the repository and
  assert the installed prompt source explicitly.
- Existing smoke scripts use Bash strict mode, a temporary root, and exit
  cleanup. The new script follows that convention and uses Node for JSON,
  package metadata, canonical paths, and portable filesystem assertions.

### Feasibility prototype

Question: can the current package be packed, installed from the exact local
tarball, and exercised outside the repository without adding a dependency?

Observation: after `pnpm install --frozen-lockfile` and `pnpm build`,
`pnpm pack` produced a tarball containing `bin/devrouter-process`,
`dist/devrouter.js`, and all 35 local upgrade prompts. Installing that exact
tarball with `npm --ignore-scripts` succeeded when `npm_config_cache` pointed
to a cache inside the temporary root. The temporary absolute binary passed
`--help`, `-V --repo`, `upgrade --repo`, and `repo inspect --repo ... --json`
from a cwd outside the repository; the inspection JSON contained all nine
required top-level fields.

Conclusion: the package boundary is implementable as a shell integration
smoke using the existing Node/pnpm/npm toolchain.

Limits and traps: the prototype ran on macOS with Node 26 rather than the
Ubuntu Node 24 CI image. The default npm cache was not writable on this
machine, so the smoke must always use a temporary cache. An optional
`cpu-features` native build warning appeared during dependency installation;
the smoke uses `--ignore-scripts` and does not depend on that optional build.
The first prototype probes also demonstrated that the repository fixture must
be passed as a canonical absolute path when the cwd is temporary.

### Planner challenge incorporated

The planner required the smoke to:

- resolve `examples/routing` once to a canonical absolute path and use it for
  every `--repo` probe;
- invoke only the absolute temporary `.bin/devrouter`, verify that its real
  package path is under the temporary installation, and require `upgrade` to
  report that same installed `upgrade-prompts` directory;
- derive declared binary members from `package.json`, compare the complete
  expected `package/...` member set against the tarball, and fail when a
  required member is missing;
- use `${TMPDIR:-/tmp}`, a validated temporary root, a cache inside that root,
  signal-safe cleanup, and Node rather than GNU-only utilities; and
- add `pnpm test:package` to `AGENTS.md` and the parent roadmap validation
  gates.

## Test portfolio

| Risk | Test obligation | Primary seam | Owner |
| --- | --- | --- | --- |
| Published assets are omitted | Pack the real candidate and compare exact tarball members for every declared binary, `dist/devrouter.js`, and every source prompt. Exercise a missing-member fixture and require non-zero status. | `scripts/package-smoke.sh` | S1 |
| A checkout, global binary, or cwd fallback hides a broken package | Run the absolute temporary executable from a separate temporary cwd; assert its resolved package path and installed prompt source. | Installed `.bin/devrouter` and `upgrade --repo` | S1 |
| Installed commands load but return malformed results | Assert stable help/version/upgrade output and parse `repo inspect --json`, checking the required fields and canonical fixture path. | Four package probes | S1 |
| CI does not execute the distribution test | Add the smoke immediately after build in the required Ubuntu `check` job and observe that step in the remote run. | `.github/workflows/ci.yml` | S2 |
| Guidance drifts from the required checks | Add the package smoke to the repository and parent-roadmap validation lists; run docs/knowledge checks. | `AGENTS.md`, parent roadmap | S2 |

No new Vitest test is planned. Existing command/core tests cover command
semantics; this smoke owns the distinct packed-installation seam.

## Delegation map

| Workstream | Slice | Route | Write ownership | Acceptance |
| --- | --- | --- | --- | --- |
| Package boundary | S1 | `executor` | `scripts/package-smoke.sh`, `package.json`, and this plan's progress entry | `pnpm build && pnpm test:package` passes with package identity, asset, command, and cleanup assertions. |
| CI and guidance | S2 | Main session; delegation skipped because the change is small and critically coupled | `.github/workflows/ci.yml`, `AGENTS.md`, `docs/project/2026-02-07-devrouter-roadmap.md`, the related release-plan evidence, and this plan's progress entry | Full local validation passes; the check job has the smoke immediately after build; guidance and release evidence are current. |

S1 receives a dedicated simplifier and slice reviewer after its immutable
commit because the shell/build-boundary harness is substantive and has
package-integrity, executable-identity, and side-effect-isolation risks. S2 is
one CI line plus documentation synchronization; it is mechanical and has no
separate simplifier or slice-reviewer pass. The integrated package receives a
required final-reviewer pass covering correctness, plan compliance,
maintainability, and security of the executable installation harness;
architecture is not applicable.

## Slice execution

### S1 — prove the packed installation

Files: `scripts/package-smoke.sh`, `package.json`, and this plan's `Progress`.

Implementation requirements:

- Expose `test:package` as `./scripts/package-smoke.sh`; keep `pnpm build` an
  explicit prerequisite and fail clearly if `dist/devrouter.js` is absent.
- Resolve the repository root, the routing fixture, package metadata, and all
  source prompt paths before entering the temporary cwd.
- Create one validated `${TMPDIR:-/tmp}` root, install a signal-safe cleanup
  trap, and keep the tarball, install prefix, npm cache, logs, and probe output
  beneath it.
- Run `pnpm pack --pack-destination` into that root and require exactly one
  tarball. Derive binary members from `package.json.bin`, require the built
  `dist/devrouter.js`, require every `upgrade-prompts/*.md`, and compare the
  exact expected `package/...` member set. A temporary member list with one
  required entry removed must fail the checker.
- Install only that absolute tarball with npm, a temporary prefix and cache,
  `--ignore-scripts --no-audit --no-fund`; do not use `npx`, a global install,
  or the host npm cache.
- Require both temporary `.bin` entries to be executable and resolve under
  `node_modules/@devrouter/cli`. Invoke only the absolute temporary
  `devrouter` binary.
- From a separate temporary cwd, run `--help`, `-V --repo`, `upgrade --repo`,
  and `repo inspect --repo ... --json` against the canonical absolute routing
  fixture. Require representative stable output, the package version, the
  canonical fixture path, the installed prompt directory, the expected
  no-new-target status, valid JSON, and the required nine inspection fields.
- Ensure success, assertion failure, install failure, command failure, and
  interruption all clean the temporary root. Do not mutate Docker, DevPod,
  TLS, router state, setup state, Git state, or the repository.

Acceptance and commit:

- `pnpm build && pnpm test:package` exits 0.
- The script's output identifies the temporary package/install boundary while
  remaining free of secret values.
- The repository has no generated tarball or temporary installation after the
  run.
- Commit: `test(package): verify packed CLI installation`.
- Review: run the simplifier and slice reviewer on the committed S1 range;
  address verified findings before S2.

### S2 — require package proof in CI and guidance

Files: `.github/workflows/ci.yml`, `AGENTS.md`,
`docs/project/2026-02-07-devrouter-roadmap.md`,
`docs/project/2026-02-08-open-source-release-plan.md`, and this plan's
`Progress`.

Implementation requirements:

- Add exactly `pnpm test:package` immediately after `pnpm build` in the
  existing `check` job. Leave the conditional `publish` job unchanged.
- Add the command after build to the `AGENTS.md` validation checklist and the
  parent roadmap's validation gates; list the new script in the AGENTS
  repository map.
- Mark the release-plan item for packed contents, `npx`, and installed
  executable verification as delivered by this package smoke, while leaving
  Docker-backed and cross-platform proof as remaining work.
- Run the complete local sequence from the package roadmap, including the
  package smoke. Remote CI acceptance remains distinct from local proof.

Acceptance and commit:

- Local docs, knowledge, quality, dependency, type, test, build, and package
  checks pass with fresh output.
- The workflow diff changes only the required check job.
- Commit: `ci: require packaged CLI smoke`.
- Skip separate simplifier and slice-reviewer passes because this slice is a
  one-line CI integration plus current-state guidance synchronization; the
  final reviewer still inspects it as part of the integrated package.

## Finish gate

Before any completion claim or PR readiness claim, run and read the full fresh
sequence:

```sh
pnpm check:docs-policy
pnpm check:knowledge
pnpm check
pnpm knip
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
```

Also inspect the exact committed diff, changed-path list, staged content, and
repository status. Run the package smoke again after the final build so its
evidence belongs to the final tree. The final reviewer must inspect the exact
implementation range after these checks. If a finding is accepted, make one
bounded correction cycle and repeat affected verification plus final review.

After separately authorized push/PR creation, observe the Ubuntu `check` job's
package-smoke step. Until that remote evidence exists, the roadmap state is
`delivery_pending`, not delivered. Do not publish, release, bump versions,
install globally, run Docker/DevPod/TLS/setup/live cleanup, delete branches or
worktrees, or merge this W1 PR without explicit authority.

## Progress

- `2026-08-15`: Created the fresh W1 worktree from `origin/main` at `f37fc03`.
- `2026-08-15`: Baseline `pnpm check:docs-policy` and
  `pnpm check:knowledge` passed; the feasibility prototype packed and
  installed the current tarball and exercised all four probes outside the
  repository. Prototype evidence is not final-branch evidence.
- `2026-08-15`: Explorer mapping completed and planner challenge incorporated.
- `2026-08-15`: Execution plan committed as `88c433b`; implementation started.
- `2026-08-15`: S1 package smoke implemented. Fresh `pnpm build` followed by
  `pnpm test:package` passed on macOS, including exact tarball membership,
  executable/package identity, temporary-cwd probes, JSON shape, and cleanup.
