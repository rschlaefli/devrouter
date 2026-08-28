# Parallel worktree TLS serialization plan

## Goal

- Make shared local TLS certificate refresh safe when several Devrouter
  worktrees start concurrently.
- Preserve every already-covered host while compacting sibling Klicker app
  hosts into valid multi-label wildcard SANs.
- Fail closed on unreadable certificates or incomplete generated coverage.

## Execution contract

- Authority: The user approved this Devrouter improvement, repository edits,
  local commits, validation, push, pull request, merge, and release when exact
  head review and CI are green.
- Terminal: A released Devrouter version serializes certificate inspection and
  refresh; the published artifact passes package smoke; two concurrent real
  refresh processes preserve both hosts; Klicker provider worktrees can run in
  parallel without replacing TLS coverage.
- Withheld: Do not change the machine workspace-runtime preference, delete
  worktrees or runtimes, access secrets, deploy, or use force push.
- Pause: Stop if safe concurrency requires global Docker cleanup, disabling
  TLS verification, or mutating unrelated workspaces.

## Package

- Repository: `rschlaefli/devrouter`
- Branch: `rs/parallel-worktree-tls`
- Worktree: `trees/parallel-worktree-tls`
- Target: `main`
- Base: released `0.0.43` at `118a8e4`
- Pull request: not created

## Findings

- Host-route state is already protected by a machine-global file lock, but the
  shared certificate was a separate unlocked read-modify-write transaction.
- Concurrent worktrees could both inspect the old certificate and then replace
  it with disjoint SAN sets.
- Preserving exact historical SANs without compaction had already grown this
  machine certificate to roughly one thousand entries, making startup slower
  and risking certificate or command-size limits.

## Do

- Serialize certificate inspection and refresh under one machine-global lock.
- Read the initial certificate once, fail closed if it cannot be parsed, and
  reuse that immutable coverage union for every generation attempt.
- Verify the generated certificate covers the full desired set before enabling
  TLS or refreshing route configuration.
- Compact two or more sibling hosts into `*.<multi-label-suffix>` while retaining
  exact one-label `.localhost` hosts because `*.localhost` does not cover them.
- Keep Docker/router restart outside the TLS lock.
- Document the ownership and developer-facing behavior.

## Check

- Focused wildcard, compaction, retry, unreadable-certificate, missing-file,
  and cross-process lock tests.
- Docs policy, knowledge validation, Biome, Knip, typecheck, full tests, build,
  and packed-install smoke.
- Real concurrent mkcert refresh from two OS processes, then read back both
  hosts and the compacted certificate size.
- Integrated final reviewer, exact-head CI, merge, release, and registry
  readback before Klicker pins the release.

## Progress

- `2026-08-28`: User approved parallel-worktree efficiency hardening.
- `2026-08-28`: Initial commit `f1578aa` added serialization, generated
  coverage verification, docs, and focused tests on current `origin/main`.
- `2026-08-28`: Reviewer found that retry could lose the initial SAN union,
  missing-file inspection sat outside the lock, and the in-process concurrency
  test did not prove cross-process serialization. All three are corrected.
- Current: correction diff passes focused 17-test TLS suite and a real
  cross-process lock test. Full validation and release remain.
