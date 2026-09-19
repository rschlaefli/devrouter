# Devsy 1.x compatibility implementation plan

Date: 2026-09-19. Branch: `rs/devsy-version-range`, rebased onto `origin/main`
`d7395bc` (0.0.79). Target: `main`. PR: draft, opened from this branch under
standing implementation delivery.

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
  Vitest passes 2274/2274 with `--no-file-parallelism`; under full file
  parallelism only `controller-server.test.ts` "replays valid cursors" hits
  its 5s timeout, then passes standalone and serially, so the failure is worker
  contention in an unrelated file. `pnpm test:process` skips on macOS because
  Linux `/proc` is unavailable.
- Rebase integration: upstream 0.0.79 (`d7395bc`) shipped a competing fallback
  in which any Devsy CLI newer than the verified pin is accepted as `ready`
  with nothing injected. The merged design keeps digest-verified per-release
  injection whenever a manifest is recorded and keeps host governance only as
  the no-manifest fallback, so neither `doctor` nor `ensure` can inject an
  unverified binary. The trust anchor above is unchanged.
- Live probes, both read-only: the changed resolver returns the published
  `v1.19.0` Linux assets with SHA-256 digests; the changed build's `doctor`
  against a real Devsy `1.19.0` checkout reports
  `state=missing, version=1.19.0, supported=>=1.16.2 <2.0.0` instead of the
  previous unsupported-version refusal (the second error, managed runtime
  drift, pre-exists in that checkout).
- Trust-anchor delta for un-pinned releases is recorded in ADR 0010 and stays
  flagged for maintainer review. This session runs the standard execution mode
  without an eligible subagent route, so no independent simplifier or
  final-review pass ran; main-session diff inspection stands in.
- Delivery: standing implementation delivery — ordinary push of this
  non-protected task branch and a draft PR. Merge, release, publication,
  workspace start, and cleanup remain withheld.
