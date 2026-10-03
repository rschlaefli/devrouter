# Worktree lifecycle: safe reclaim, trim and installable skills

## Approval summary

Agent-driven work leaves Git worktrees behind. In one consumer repository, 515
worktrees filled a 1.8 TB disk to 14 GiB free. A personal shell skill
(`rs-worktree-reclaim`) reclaimed 256 of them safely, but devrouter could not
help: `workspace cleanup` builds rows only from the ownership ledger, so it
reported 0 of 94 worktrees in this repository. `workspace down` also skips
checks that matter. It does not look at ignored files, submodules or
in-progress Git operations, and `cleanup` already suggests it for merged rows.

This plan delivers three packages:

- **A. Safer `workspace down`** (fix). It runs the local Git-safety checks
  before deleting anything.
- **B. Installable skills.** A generic `worktree-reclaim` skill works with Git
  and `gh`/`glab` alone, and a `devrouter-setup` skill installs devrouter and
  its machine dependencies. All shipped skills install with `npx skills add
  rschlaefli/devrouter`. A shared fixture corpus defines the Git-safety
  verdicts and reason codes.
- **C. Worktree engine in devrouter.** It covers every registered worktree in
  `workspace cleanup --all-worktrees`. It adds `workspace reclaim` and
  `workspace trim`, both bound to an approved manifest hash. The skill switches
  to devrouter when a capable version is installed, and both classifiers must
  pass the same corpus.

Unchanged: report-only stays the default. Every deletion, including trim, needs
an approved manifest hash. Uncertain facts resolve to KEEP. Managed teardown
keeps its existing locks and order. Without `--all-worktrees`, the cleanup report
keeps schema version 2. devrouter never reads agent-client history; the skill
supplies that check through a veto command.

Risks: two classifiers (shell and TypeScript) can drift. The control is the
shared corpus with reason codes, run in CI. Package C extends destructive
authority beyond the ownership ledger, so it records an ADR. The `worktrees:`
key in `.devrouter.yml` is rejected by devrouter versions without this change.
The release note must say so; the release itself is withheld.

Done when all three packages pass the repository checks and the corpus. A dry
run on this repository and on the consumer repository must also show every
verdict difference from the existing skill traced to a contract change listed
below.

Approval mode: **executable batch**. It authorizes:

- source and documentation changes, tests and configured reviews;
- commits, ordinary non-force pushes to the three task branches and draft PRs;
- merging `origin/main` into task branches;
- read-only dry runs on this machine;
- skill installs into a temporary, isolated `HOME`.

Withheld, each needing its own approval:

- marking PRs ready, merging, any release or npm publish, global installs;
- any real (`--yes`) reclaim or trim on the user's machine;
- consumer repository changes, retiring the dotfiles skill and the team
  announcement.

## Execution details

### Baseline and working context

- Base: `324985f` (`origin/main`, after the 0.1.3 release).
- Worktree: `trees/rs/worktree-lifecycle`, branch `rs/worktree-lifecycle`
  (package B). Packages A and C get sibling worktrees under `trees/rs/`.
- Artifacts root: `docs/project/`. Ceremony: full path. Risk boundaries:
  deletion of user data and cross-system teardown.
- Direction and decisions 1–6 (ruled 2026-10-03) live in the consumer
  repository's local planning notes, which are not public. The binding
  contracts below restate everything execution needs.
- Source skill: `rs-worktree-reclaim` in the user's dotfiles. B1's commit
  message records the source dotfiles commit SHAs. Its unpushed fixes are forge
  retries, bulk GitHub PR listing, the submodule guard and repository
  disposable paths.

### Evidence in this repository

- Rows come only from the ledger: `src/core/workspace-cleanup.ts:1091,1115`,
  `src/core/workspace-ownership.ts:139-141`. The row type at
  `workspace-cleanup.ts:101-107` requires `workspace` and `devpodId`.
- Merge rule: an absent origin source branch yields `unknown`
  (`workspace-cleanup.ts:632-641`). A merged change must match HEAD, the origin
  source branch SHA and the origin default branch
  (`workspace-cleanup.ts:687-693`). Forge query, per branch:
  `workspace-cleanup.ts:643-669`.
- `workspace down` preflight is `git status --porcelain --untracked-files=normal`
  plus locks (`src/core/workspace-lifecycle.ts:248-272`). `cleanup` suggests it
  for `merged-exact` rows (`workspace-cleanup.ts:892-899`).
- Locks are not re-entrant (`src/core/file-lock.ts:397-423,454-465`).
  `deleteOwnedDevpodWorkspace` takes the DevPod mutation lock itself
  (`src/core/devpod-mutation.ts:56-68,115`). The lifecycle lock is per worktree
  (`workspace-lifecycle.ts:552-554`). The exact-path delete entry point is
  `workspaceDeleteOwnedPath` (`workspace-lifecycle.ts:591`).
- Strict config keys: root key list `src/core/repo-config.ts:1090-1103`, helper
  `ensureAllowedKeys` at `:113`.
- Embedded skill: `repo agents` writes the `devrouter` skill
  (`src/core/agents-md.ts:8-12`). Shipped skills live in `.agents/skills/`
  (`devrouter`, `devcontainer-onboarding`). The npm package ships only `bin`,
  `dist` and `upgrade-prompts` (`package.json:12-16`); skills install from
  GitHub, so `files` and `knip.json` do not change.
- Tests: vitest includes `src/**/__tests__/**/*.test.ts` (`vitest.config.ts:5`).
- Docs policy: `scripts/check-docs-policy.sh:19-28,37` (manual surfaces, and a
  ban on version wording in manuals). Upgrade prompts appear in
  `devrouter upgrade` as soon as the file exists (`src/core/upgrade.ts:94-98`).

### Contract changes from the source skill

B1 makes these changes during the import. Each must appear in B1's commit
message and in the parity report:

1. Any `index.lock` is a KEEP reason. The source skill has no such check
   (`lib-classify.sh:208-317`).
2. When several changes exist for a branch, the newest one decides. The source
   uses the first listed row (`lib-classify.sh:89-90`).
3. Cross-repository (fork) changes never count as merge evidence, matching
   devrouter today.
4. Neither tool deletes a runtime of an unmanaged tree; such trees are KEEP
   (decision 6). The source deletes unmanaged DevPods by source path
   (`reclaim.sh:132-156`).
5. For managed trees, the skill no longer calls `devrouter stop --delete`
   (`reclaim.sh:121-130`). It delegates the whole reclaim to `devrouter
   workspace reclaim` when available, and otherwise keeps the tree.
6. The manifest kind becomes `worktree-reclaim-manifest` version 1. The source
   kind `rs-worktree-reclaim-manifest` (`manifest.py:17`) is still accepted for
   reading.
7. Disposable patterns use the grammar below. The old override syntax
   (shell-`case` globs matched against `/<path>/`) is still read, with a
   deprecation note in the report.

Kept as is: empty ignored files count as disposable (`lib-classify.sh:170`).
GitLab lookups in the skill stay per branch (`lib-classify.sh:103-116`, needs
`jq`); only devrouter adds a GitLab bulk listing.

### Binding contracts

**Git-safety verdict.** One definition, used by the skill, `reclaim`, `trim`
(local checks only) and `workspace down` (local checks only). Each failed check
emits a stable reason code. Codes are machine values; wording is free.

| Check | KEEP code |
| --- | --- |
| Primary checkout | `primary` |
| Detached HEAD or unreadable HEAD | `detached` |
| Worktree lock | `locked` |
| Any `index.lock` | `index-lock` |
| Merge, rebase, cherry-pick, revert or bisect in progress | `operation-in-progress` |
| Initialized submodules (`<worktree-git-dir>/modules` exists) | `submodule` |
| Tracked changes | `dirty` |
| Untracked files | `untracked` |
| Ignored path not disposable | `ignored-state` |
| A Git check failed (not a worktree, status, operation or lock probe) | `git-error` |
| Runtime, ledger-less DevPod or route evidence on an unmanaged tree | `runtime-present` |
| Forge not checked (no `--check-merged`) | `forge-not-checked` |
| Forge unavailable after retries, or CLI missing | `forge-unavailable` |
| No change for the branch | `no-change` |
| Newest change open | `change-open` |
| Newest change closed unmerged | `change-closed` |
| HEAD not equal to or ancestor of the merged head | `head-beyond-merge` |
| Activity inside the window, or veto denied | `active` |

- RECLAIM: no KEEP code applies, and the newest same-repository change for the
  branch is merged into any base. A deleted source branch is allowed.
- "Newest" means the highest PR or MR number. Fork changes are excluded before
  choosing: GitHub `isCrossRepository`, GitLab `source_project_id !=
  target_project_id`.
- Runtime evidence for `runtime-present` is any of: a devrouter ownership
  record (`<git-common-dir>/devrouter/workspaces/*.json`, `worktreePath`), a
  devrouter host route (`host-routes-state.json`, `repoPath`), a DevPod
  (`devpod list --output json`, `source.localFolder`) or a Devsy workspace
  (`devsy workspace list --result-format json --skip-pro`), each matched on the
  exact real path. A source that exists but cannot be read also yields
  `runtime-present`.
- PRUNE: the registration's folder is gone. It is reported only.
- Disposable ignored paths:
  - the built-in reproducible-cache list carried over from the source skill;
  - empty ignored files;
  - the repository's `worktrees.disposable` patterns (devrouter only);
  - the local override file `<git-common-dir>/info/worktree-reclaim-disposable`
    (both tools).

**Pattern grammar.** Patterns are relative to the worktree root and use `/` as
separator. `*` matches within one path segment and `**` matches zero or more
whole segments. A pattern matches a path and everything beneath it. Patterns
must not be absolute or contain `..`. Both classifiers match against the
paths that `git status --porcelain --ignored` reports, with any trailing `/`
removed.

**`.devrouter.yml`.** An optional root key `worktrees` holds `disposable` and
`trim`, both string arrays in the pattern grammar. It is validated through the
root key list and `ensureAllowedKeys`. The shell skill does not parse YAML. When
devrouter is absent it ignores these patterns, so more trees stay KEEP. Package
A ships the built-in list, the override reader and the empty-file rule in
TypeScript. Package C adds the `worktrees` key.

**Forge access.**

- GitHub: one `gh pr list --repo <project> --state all --limit 1000 --json
  number,headRefName,headRefOid,baseRefName,state,mergedAt,updatedAt,isCrossRepository`
  call per repository and run.
- GitLab: `glab api --paginate "projects/<id>/merge_requests?state=all&per_page=100"`,
  capped at 10 pages.
- Three attempts with backoff.
- devrouter keeps the listing in memory for one command run; it writes no cache
  file. The skill keeps its existing short-lived cache in `$TMPDIR`.
- `reclaim` fetches the listing fresh at apply start.

**Cleanup report.**

- Without `--all-worktrees`: schema version 2, unchanged rows and statuses.
- With `--all-worktrees`: schema version 3. It adds unmanaged rows, and every row
  carries `safety: {verdict, codes}`. Ledger rows keep their existing
  integration statuses.
- Forge calls still require `--check-merged`. Without it, rows get
  `forge-not-checked` and are never RECLAIM.
- The `workspace down` suggestion requires the existing `merged-exact` status
  and a passing local safety check (package A).
- `--manifest` writes the manifest to stdout, or to `--output <path>`. Nothing
  else is written.

**Manifest.**

- Kind `worktree-reclaim-manifest`, version 1, canonical JSON, SHA-256 content
  address, strict schema. Canonical JSON means sorted keys, 2-space indent,
  UTF-8 without ASCII escaping, and a trailing newline.
- Field `action`: `reclaim` or `trim`. Trim rows list the exact paths to remove.
- Each row binds candidate ID, repository, path, branch ref, HEAD, Git common
  dir and worktree Git dir.
- Session fields (`activeWithin`, `allHistory`, `session*`) are optional.
  devrouter omits them and records `activitySource: "devrouter"`; the skill
  records `activitySource: "agent-sessions"`.
- Both tools read either tool's manifests.
- 24-hour default expiry, printed in every report.
- CLI forms: `devrouter workspace manifest hash <file>` and `devrouter
  workspace manifest select <file> --expected-sha256 <h> --id <id>...`. The
  skill's `manifest.py hash|select` must produce byte-identical output.

**Apply (`reclaim` and `trim`).**

- Usage: `devrouter workspace reclaim|trim --manifest <file> --sha256 <h>
  [--veto-command <abs-path>] [--yes]`. It is a dry run without `--yes` and
  never adds targets.
- Per target, take exactly one lifecycle-lock acquisition through an exact-path
  entry point modeled on `workspaceDeleteOwnedPath`. Inside it: re-check
  identity, re-run the verdict and run the veto command, then mutate. Never
  wrap the provider lock; provider internals take it themselves. Locks are
  never held across targets.
- Reclaim teardown order: managed runtime and routes through the existing
  delete internals, then `git worktree remove` without `--force`, then
  `git branch -D` only if the branch tip still equals the manifest HEAD.
- Trim teardown: remove each listed path after re-checking it. Never follow
  symlinks, and skip a path that is a symlink. The realpath must stay inside the
  worktree. A path that contains tracked files is never removed.
- Outcome classes:
  - **Skip** (pre-mutation, continue): stale identity, verdict now KEEP, veto
    denied, lock-wait timeout.
  - **Failure** (stop the batch): an error after any mutation began, an
    environment failure (forge authentication, missing tool, permission denied,
    missing or non-executable veto command) and a second error with the same
    error code.
- The report lists every skip and failure, and the exact steps completed for
  any half-finished target.
- Receipts: `<git-common-dir>/worktree-reclaim/receipts/<manifest-sha256>/<candidate-id>.json`,
  written by both tools after each completed target. On a re-run, a gone target
  with a matching receipt counts as done. A receipt is canonical JSON with
  `kind: "worktree-reclaim-receipt"`, `schemaVersion: 1`, `tool`,
  `manifestSha256`, `candidateId`, `path`, `branchRef`, `head`,
  `completedAtEpoch` and `steps` (`worktree-removed`, then `branch-deleted`
  unless the branch was kept). Matching compares kind, version, hash, candidate,
  path and HEAD.

**Veto command.**

- Takes an absolute path and runs with argv `[<path>, <worktree-path>]`. There
  is no shell.
- Timeout 30 seconds; a timeout counts as a veto.
- Exit 0 allows the mutation; any other exit vetoes it.
- The skill's adapter is `scripts/session-veto.sh`. It reuses the incremental
  session index, so a per-target call stays short while the lock is held. C4
  records the measured per-call time.
- Without a veto command, `reclaim` acts only on trees whose devrouter activity
  evidence is older than `--inactive-for` (default 24h). `trim` uses the same
  rule with a 14d default. For unmanaged trees, activity includes the index and
  working-tree modification times.

**Trim selection.** `cleanup --manifest --action trim` lists, per tree, the
existing paths that match `worktrees.trim`. It covers only trees that pass the
local safety checks and the activity window and have no running runtime or
attributed containers. There is no built-in trim list; a repository without
declarations gets no trim rows. A skill-side trim script is deferred. Without
devrouter, the skill reports trim as unavailable.

**Skill delegation.** The skill uses devrouter when `devrouter` is on `PATH` and
`devrouter workspace reclaim --help` succeeds. It then passes its session
adapter as the veto command, plus `--max-age`, which `workspace reclaim` must
accept. `WORKTREE_RECLAIM_NO_DEVROUTER=1` forces the skill's own path. Otherwise it runs its own scripts, and trees with
any runtime evidence stay KEEP with a hint to install devrouter.

**Setup skill confirmations.** `devrouter-setup` detects first. It then asks
before each state-changing step, one step at a time: every dependency install,
`npm install -g @devrouter/cli`, `devrouter setup --yes` and `devrouter tls
install`. It never edits agent configuration and gives sandbox settings as
instructions.

### Delivery topology and delegation map

| Package | Branch | PR base |
| --- | --- | --- |
| A | `rs/workspace-down-safety` | `main` |
| B | `rs/worktree-lifecycle` | `main` |
| C | `rs/worktree-engine` | `rs/worktree-lifecycle` |

C merges A's branch once A's checks pass (merge commit). After B merges, C
merges `origin/main` and its PR base is changed to `main`. No rebase and no
force-push.

| Slice | Owner | Depends on | Acceptance | Gates |
| --- | --- | --- | --- | --- |
| A1 | main | none | New refusals fail before, pass after; lifecycle tests pass | simplifier, slice reviewer, final reviewer (A) |
| B1 | main | none | Skill tests and corpus pass; parity report against the dotfiles skill | simplifier, slice reviewer |
| B2 | main | none | Four skills listed and installed into an isolated `HOME`; detection report correct | simplifier, final reviewer (B) |
| C1 | main | A1, B1 | Corpus passes in TypeScript; parity report on two repositories | simplifier, slice reviewer |
| C2 | main | C1 | Apply test rows pass; dry run mutates nothing | simplifier, slice reviewer |
| C3 | worker, main verifies | C2 | Trim rows pass; dry run lists only declared paths | simplifier, slice reviewer |
| C4 | main | B1, C2, C3 | Skill tests pass with devrouter on and off `PATH` | simplifier, final reviewer (C) |

### Test portfolio

**Shared corpus,** at `tests/worktree-safety/`, at the repository root so it
does not ship with the skill:

- `build-scenario.sh <name> <dir>` creates one scenario: a bare origin, a clone
  and worktrees.
- `stubs/` holds PATH stubs for `gh`, `glab`, `devpod` and `devsy`. They keep
  state in a scenario file, which supports the "fail once, then succeed" rows.
- `expected.tsv` has the columns `scenario`, `forge`, `verdict` and `codes`,
  with codes sorted.
- Every forge-dependent row runs under both forges.
- Runs use a temporary `HOME` and `DEVROUTER_HOME`, with a route fixture for the
  `runtime-present` row.
- Scenarios:
  - one per KEEP code;
  - squash merge;
  - HEAD behind the merged head;
  - deleted source branch;
  - stacked base;
  - older merged change with a newer open change;
  - fork change;
  - disposable and empty ignored files;
  - old-syntax override;
  - PRUNE.
- Runners: `tests/worktree-reclaim/run-corpus.sh` for the skill (B1) and
  `src/core/__tests__/worktree-safety-corpus.test.ts`, which calls the core
  function in-process (C1).

| Behavior | Seam | Package |
| --- | --- | --- |
| Verdicts and codes | Shared corpus | B1, C1 |
| `workspace down` refuses ignored state, submodules, operations in progress and `index.lock` | `workspace-lifecycle.test.ts` | A1 |
| Manifest hash, expiry, select; cross-tool: a skill manifest validates in devrouter, `select` output byte-identical | Skill manifest tests; one vitest cross-tool test | B1, C2 |
| Skip versus failure classes, repeated-code stop, half-finished report, receipts on re-run, lock composition without deadlock | vitest with stubbed teardown | C2 |
| Veto allow, deny, timeout, missing command | vitest | C2 |
| Trim keeps tracked files, skips symlinks and paths that escape the tree, skips dirty, running and active trees | vitest with temporary repositories | C3 |
| `worktrees` config validation | `repo-config.test.ts` | C1 |
| Shipped skills install | CI: `npx skills@<pinned> add . --list` | B2 |

No test asserts wording.

### Slices

**A1. Local safety checks for `workspace down`.**

- New module `src/core/worktree-safety.ts`. It holds the local checks with
  reason codes, the built-in disposable list, the empty-file rule, the pattern
  matcher and the override reader. Packages A and C share it.
- `workspace down` refuses when any local check fails.
- `cleanup` suggests `workspace down` only when the checks pass.
- Also touches: `src/core/workspace-lifecycle.ts`,
  `src/core/workspace-cleanup.ts`, their tests,
  `docs/knowledge/managed-environment-lifecycle.md` (with `source_paths`) and
  a `CHANGELOG.md` `[Unreleased]` entry.
- Checks: everything in Verification except `pnpm test:skills`.

**B1. Import `worktree-reclaim` and the corpus.**

- Copy the skill into `.agents/skills/worktree-reclaim/`: scripts and
  references. Use a generic name, with no `rs-` references and no personal
  paths.
- Its tests move to `tests/worktree-reclaim/`.
- Apply the contract changes above. Add the new reason codes to the shell
  classifier's output and add `scripts/session-veto.sh`.
- Add the corpus at `tests/worktree-safety/`.
- Add a `pnpm test:skills` script and run it in CI.
- Parity report: run the imported and the dotfiles skill read-only on this
  repository and the consumer repository. Trace every difference to a
  numbered contract change. Put only sanitized counts per code in the PR, with
  no paths or branch names.

**B2. `devrouter-setup` skill and skills.sh packaging.**

- New `.agents/skills/devrouter-setup/`. It detects the OS, a Docker-compatible
  runtime, DevPod or Devsy, Node, `mkcert`, Git and `gh`/`glab`, then follows
  the setup confirmation contract above.
- It compares the installed devrouter version with a repository's required
  minimum.
- Check the frontmatter of all four skills. Mark any repository-internal skill
  `metadata.internal: true`.
- Add the pinned `npx skills add . --list` step to `.github/workflows/ci.yml`.
- Docs: one install line in `README.md` and the setup path in
  `docs/GETTING_STARTED.md`.
- Verification: a global install into a temporary `HOME`, with `CODEX_HOME` and
  `CLAUDE_CONFIG_DIR` set to temporary folders. Then a detection-only run on
  this machine.

**C1. Verdicts for all worktrees.**

- Complete the verdict in `src/core/worktree-safety.ts`.
- New `src/core/forge-changes.ts` holds the bulk listings and the newest-change
  and fork rules. It replaces the per-branch query in `workspace-cleanup.ts`
  for the safety verdict; ledger integration statuses keep their current rule.
- Add `--all-worktrees`, schema version 3 and the `worktrees` config key.
- Add the corpus runner.
- Parity report as in B1, now comparing devrouter with the imported skill. The
  only allowed difference is the `.devrouter.yml` patterns.

**C2. `workspace reclaim` and manifests.**

- New `src/core/worktree-reclaim.ts`: manifest emit and validation, `manifest
  hash|select`, the exact-path apply entry point, the veto runner, outcome
  classes and receipts.
- Wiring in `src/commands/workspace.ts` and `src/cli.ts`.
- New ADR `docs/adr/0011-worktree-reclaim-outside-the-ledger.md`. It records
  that reclaim deletes unmanaged worktrees and branches under the verdict
  contract, and why no unmanaged runtime is deleted.
- Update `AGENTS.md` (command surface, repository map, the ledger-scoped
  destructive-commands rule) and
  `docs/knowledge/managed-environment-lifecycle.md`.

**C3. `workspace trim`.**

- New `src/core/worktree-trim.ts`: trim rows in the manifest and trim apply
  under the shared apply contract.
- A worker implements it against C2's settled interfaces; main verifies.

**C4. Skill switch and agent guidance.**

- The skill delegates to devrouter when capable.
- Update `.agents/skills/devrouter/SKILL.md` and its embedded copy in
  `src/core/agents-md.ts`, plus `src/core/ai-prompt.ts` with its test.
- Update `docs/REPO_ONBOARDING.md` (worktree declarations and prevention
  defaults, without version wording), the knowledge `source_paths` and any
  docs-policy surfaces the new files touch.
- Add the measured veto-call time to the PR and the `CHANGELOG.md`
  `[Unreleased]` entries. The upgrade prompt and its warning about the
  `worktrees` key belong to the separately approved release.

**Index.** The commit that adds this plan also adds it to `docs/project/index.md`
under Active.

### Verification

- Per package: `pnpm check:docs-policy`, `pnpm check:knowledge`, `pnpm check`,
  `pnpm knip`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:package`.
  Packages B and C also run `pnpm test:skills`.
- Machine checks are read-only dry runs. PR text carries sanitized counts only.

### Follow-ups outside this batch

1. Release the next devrouter version, with the upgrade prompt, and install it
   globally.
2. One real approved reclaim, bound to a named manifest hash.
3. Consumer adoption: add `worktrees:` declarations, raise the devrouter
   minimum in the same commit, sync the embedded skill and convert or remove
   the local override file.
4. Retire `rs-worktree-reclaim` in dotfiles in favor of the installed skill.
5. Team announcement with the install line and onboarding checklist; optional
   weekly report-only routine; skill-side trim script.

## Progress

- [x] Direction approved, decisions 1–6 ruled (2026-10-03).
- [x] Worktree `trees/rs/worktree-lifecycle` created from `origin/main` `324985f`.
- [x] Planner pass (REVISE) folded in: lock composition, outcome classes, trim
  manifest binding, pattern grammar, reason codes, corpus mechanics, contract
  changes from the source skill, no force-push, `[Unreleased]` changelog, ADR,
  sanitized PR evidence.
- [x] Plan approval (2026-10-03). No native goal tool in this harness; this Progress list tracks the objective.
- [x] Package A: draft PR rschlaefli/devrouter#126 (`73e302f`). Adds the
  `git-error` code for a failed Git probe, now in the code table.
- [ ] Package B.
  - [x] B2 committed and reviewed (`8e16529`).
  - [x] B1 implemented. Corpus deviations: no bare origin (the classifier no
    longer reads upstreams, so an origin URL suffices); three forge modes
    (`github`, `github-bulk`, `gitlab`) instead of two; an extra
    `older-open-newer-merged` row. The corpus reads verdicts through
    `read < <(...)`, which caught a bash 3.2 bug where a caller's temporary
    `IFS` leaked into the classifier.
- [ ] Package C.
