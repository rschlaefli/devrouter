# Devsy 1.x compatibility implementation plan

Date: 2026-09-19. Branch: `rs/devsy-version-range`, rebased onto `origin/main`
`d7395bc` (0.0.79). Target: `main`. PR: draft
[#106](https://github.com/rschlaefli/devrouter/pull/106).

## Approval summary

Why and what changes: Devrouter requires the installed Devsy CLI to be exactly
`1.16.2`. Every Devsy update therefore blocks managed starts with
`global.devsy-agent` stale, and `ensure` fails before the provider queue. The
lock exists because Devrouter injects a verified Linux agent through
`DEVSY_AGENT_BINARY`, and its committed manifest covers one version only. This
package replaces exact equality with a supported range (`>=1.16.2 <2.0.0`),
resolves the official Linux agent for the installed version, verifies it
against the SHA-256 digest GitHub reports for that release asset, and records
the verified manifest in Devrouter machine state so `doctor` and `ensure` stay
network-free and fail closed.

What stays unchanged: Devrouter still owns acquisition (no implicit download
during `ensure`), still validates a source before provider mutation, still
never writes Devsy's private cache or desktop environment, and still rejects
explicit `DEVSY_AGENT_BINARY` overrides that do not match an official asset.
Versions below the range floor or above the ceiling stay stale.

What could change the decision: for a version Devrouter has not pinned in
source, the digest comes from the GitHub release API at acquisition time, so
the trust anchor is the same release GitHub serves rather than a value
committed in this repository. This is the material trade-off of the range
policy; the pinned manifest stays authoritative for `1.16.2` and remains the
offline path.

How we know it is done: unit coverage for range acceptance, out-of-range
rejection, release metadata resolution, digest mismatch, cached-manifest reuse,
and explicit overrides; `pnpm check`, `knip`, `typecheck`, `test`,
`check:docs-policy`, and `check:knowledge` pass; `doctor` reports a readable
state for an installed Devsy `1.19.0` without network access.

What approval authorizes: local commits on this branch, running
repository-native checks, one read-only `doctor` probe, and standing
implementation delivery — an ordinary push of this non-protected task branch
and a draft PR. Withheld: merge, release or npm publication, workspace start,
and cleanup.

## Execution contract

- Execution owner: this main session (Codex standard mode; no solo
  allowlist match).
- Autonomy: user instruction `proceed` on the proposed range policy authorizes
  S0-S3 without intermediate human checkpoints.
- Authority: edit the named branch and worktree; add plan, ADR, source, tests,
  manuals, knowledge, generated guidance, and an `[Unreleased]` changelog
  entry; create local commits; run read-only diagnostics.
- Terminal: S0-S3 committed, fresh checks pass, review findings dispositioned,
  `Progress` current.
- Delivery layer: verified local branch. Withheld: push, PR/MR, merge,
  release, publication.
- Pause: GitHub reports no SHA-256 digest for a needed asset; the range policy
  would require changing DevPod behavior; or a check failure is unrelated and
  cannot be isolated.

## Research

- Evidence: `src/core/devsy-agent.ts` exports
  `SUPPORTED_DEVSY_VERSION = "1.16.2"`, compares `devsy --version` for exact
  equality, and caches the agent under `v<version>` in Devrouter state.
- Evidence: live `devrouter doctor --repo <devsy-owned checkout>` reports
  `global.devsy-agent ERROR state=stale, version=1.19.0`, and
  `ensure` fails before the provider queue.
- Evidence: Devsy itself only warns when the injected agent version differs
  from the CLI version (`pkg/agent/inject.go` version check); the hard gate is
  Devrouter's own equality check.
- Evidence: Devsy publishes `devsy-linux-arm64` and `devsy-linux-amd64` for
  every release, and the GitHub release API reports a `sha256:` digest. For
  `v1.16.2` that digest equals the value committed in this repository
  (`31060b96...`), so the dynamic path uses the same integrity value.
- Evidence: `src/core/network-provider-inspect.ts` repeats the exact-version
  gate (`expectedVersion = "1.16.2"`) for network binding evidence and fails
  closed on any other version.

## Slices

- S1: supported range + per-version manifest resolution in
  `src/core/devsy-agent.ts`, with recorded manifests in machine state and
  network-free inspection. Tests in `src/core/__tests__/devsy-agent.test.ts`.
- S2: apply the shared range predicate to network binding evidence in
  `src/core/network-provider-inspect.ts`, keeping DevPod pinned and every
  definition-shape check intact.
- S3: setup/doctor wording, distributed agent guidance, manuals, knowledge,
  ADR 0010, and the changelog entry.

## Verification

- `pnpm check`, `pnpm knip`, `pnpm typecheck`, `pnpm test`,
  `pnpm check:docs-policy`, `pnpm check:knowledge`.
- Focused: `pnpm vitest run src/core/__tests__/devsy-agent.test.ts`.
- Live: `devrouter doctor` (installed 0.0.77) remains the pre-change baseline;
  the changed build is proven by unit coverage plus a read-only probe of the
  resolver against the published `v1.19.0` release metadata.

## Progress

- S0 plan record: done.
- S1 supported range plus per-version manifest resolution in
  `src/core/devsy-agent.ts`, with unit coverage in
  `src/core/__tests__/devsy-agent.test.ts`: done.
- S2 network binding evidence in `src/core/network-provider-inspect.ts` uses
  the shared range predicate; DevPod stays pinned at `0.6.15`: done.
- S3 setup/doctor wording, distributed guidance, manuals, knowledge, ADR 0010,
  and the `[Unreleased]` changelog entry: done.
- Checks on 2026-09-19: `pnpm check`, `pnpm knip`, `pnpm typecheck`,
  `pnpm check:docs-policy`, `pnpm check:knowledge`, and `pnpm build` pass.
  Vitest passes 2639/2639 in 146 files with `--no-file-parallelism` on the
  rebased head and 2657/2657 in 147 files after integrating current `main`;
  CI run 35471841423 is green for merge commit `c7e8966`. Under full file
  parallelism only `controller-server.test.ts` "replays valid cursors" hit
  its 5s timeout, then passed standalone, serially, and in CI, so the failure
  was worker contention in an unrelated file. `pnpm test:process` skips on
  macOS because Linux `/proc` is unavailable.
- Rebase integration: upstream 0.0.79 (`d7395bc`) shipped a competing fallback
  in which any Devsy CLI newer than the verified pin is accepted as `ready`
  with nothing injected. The merged design keeps digest-verified per-release
  injection whenever a manifest is recorded and keeps host governance only as
  the no-manifest fallback, so neither `doctor` nor `ensure` can inject an
  unverified binary. The trust anchor above is unchanged. Current `main` was
  integrated again after #105 (`e1ef9ea`) landed; only the `[Unreleased]`
  changelog conflicted, and both entries are kept.
- Live probes, read-only: the resolver returned the published `v1.19.0` Linux
  assets with SHA-256 digests; on the rebased and post-merge builds, the built
  CLI's `doctor` against a real Devsy `1.19.0` checkout reports
  `global.devsy-agent` warn `state=ready, source=host, version=1.19.0,
  supported=>=1.16.2 <2.0.0` with the `setup --workspace-runtime devsy`
  suggestion, instead of the previous stale version refusal. `setup` itself
  did not run, so no agent was downloaded and no manifest was recorded in
  machine state.
- Trust-anchor delta for un-pinned releases is recorded in ADR 0010 and stays
  flagged for maintainer review. This session runs the standard execution mode
  without an eligible subagent route, so no independent simplifier or
  final-review pass ran; main-session diff inspection stands in.
- Delivery: standing implementation delivery — ordinary pushes of the
  non-protected task branch and a draft
  [PR #106](https://github.com/rschlaefli/devrouter/pull/106) with green CI on
  `c7e8966`. That PR merged to `main` as `7f53c74` on 2026-09-20T09:24:17Z.
  The release commit shipped separately as
  [PR #112](https://github.com/rschlaefli/devrouter/pull/112) (`ff91850`) with
  CI runs 35502518731 and 35502674474 green, and GitHub release
  [v0.0.80](https://github.com/rschlaefli/devrouter/releases/tag/v0.0.80)
  published it at 09:34:13Z. That release event published
  `@devrouter/cli@0.0.80` with provenance: run 35502687940 logs the npm OIDC
  audience exchange and `Published package` at 09:37:34Z, and the registry
  holds two attestation signatures whose subject digest matches
  `dist.integrity`.
- Registry propagation: the packument recorded 0.0.80 at 09:39:40Z while the
  tarball only answered `200` at 09:43:51Z. During that gap `npm install`
  failed with `E404` after `ETARGET`, and `volta install` reported the
  version as absent from the package registry. The version was already
  registered, so another publish would have been refused as a duplicate. Every
  install below ran after the tarball was downloadable, and nothing was
  unpublished.
- Local adoption on this host: `devrouter` is installed three times — the
  `~/.local` npm prefix, the volta package behind `~/.volta/bin`, and a stale
  `npm install -g` copy inside volta's node image that `doctor`'s new
  `global.cli-path` check flagged. All three moved to 0.0.80, and to 0.1.0
  after that concurrent release published. `global.cli-path` now reports ok
  with `~/.volta/tools/image/node/24.16.0/bin/devrouter=0.1.0,
  ~/.volta/bin/devrouter=0.1.0, ~/.local/bin/devrouter=0.1.0` against running
  version 0.1.0.
- Live consumer check, read-only, against the `klicker-uzh` checkout whose
  `.devrouter.yml` records 0.0.72: `devrouter -V` reports the installed CLI
  version, that local repo version and the next upgrade target, and `doctor`
  reports `global.devsy-agent` warn with `state=ready, source=host,
  version=1.19.0, supported=>=1.16.2 <2.0.0` plus the `setup
  --workspace-runtime devsy` suggestion. An in-range Devsy release is therefore
  ready with a warning and nothing is injected. `setup` did not run, so no
  manifest was recorded and no agent was downloaded.
- Still withheld: the `setup --workspace-runtime devsy` adoption step stays a
  user-run action, and the merged task branches and worktrees need separate
  cleanup approval.
