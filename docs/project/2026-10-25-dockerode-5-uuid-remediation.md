# Dockerode 5 UUID remediation

Status: prepared and locally qualified; not published or activated downstream.

## Scope and identity

- Branch: `rs/dockerode-5-uuid-remediation`, targeting `main`.
- Base: `033eaf6` (`@devrouter/cli` 0.5.4), inspected 2026-10-25.
- Replace the direct Dockerode 4 dependency with stable Dockerode 5.0.1 and
  regenerate the pnpm lock without unrelated upgrades. Preserve existing public
  CLI behavior and current Node/pnpm pins. Do not publish, merge, install globally,
  alter CI rollout flags, override UUID, or suppress advisories.
- Prepare the Klicker CI adoption evidence using a local tarball in a disposable
  copied toolchain. Its active published-version pin stays unchanged until a
  separately authorized fixed CLI release exists.

## Evidence and compatibility review

The current Devrouter lock resolves Dockerode 4.0.9 and UUID 10.0.0; a fresh
consumer install of CLI 0.5.1 resolves Dockerode 4.0.12 and the same UUID version.
Dockerode 4 requires `uuid:^10.0.0`, so updating within that constraint cannot
reach patched UUID 11.1.1. [GHSA-w5hq-g745-h8pq / CVE-2026-41907](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
affects UUID's v3/v5/v6 output-buffer paths. Dockerode 4 uses v4 without an output
buffer; no affected call path was identified, but the dependency remains flagged.

[Dockerode 5.0.0 release notes](https://github.com/apocas/dockerode/releases/tag/v5.0.0)
document removal of UUID and a Node minimum increase. Official npm metadata for
5.0.1 requires Node >=14.17, below Devrouter's existing >=24 requirement. Its
CommonJS entry, constructor, listContainers, getNetwork().inspect() and
createNetwork() are the runtime surface this repository uses; routes imports
ContainerInfo only as a type. Keep the existing narrow client boundary and
independently prove real transport behavior instead of relying on mocked clients.

This is a deliberately scoped security upgrade, not a general dependency audit.
The four runtime dependencies and eight development dependencies were inventoried
in package.json; unrelated versions, @types/dockerode, runtime pins, build target,
CI workflow, package publication, provider state and credentials remain unchanged.
No knowledge-concept impact is expected: routing, lifecycle ownership, configuration
and command contracts are unchanged.

## Ordered implementation and gates

1. Record this plan and verify the clean isolated checkout and official metadata.
2. Change `package.json` to Dockerode `^5.0.1`, regenerate `pnpm-lock.yaml`, inspect
   the complete graph delta and verify UUID is absent from runtime dependencies.
3. Add real-library regression tests against local HTTP and Unix-socket Docker
   API fixtures. Cover context/pinned endpoint selection, container list and
   lookup, network inspect/create, and propagated errors without touching the
   user's Docker daemon or router state.
4. Run repository docs/knowledge, Biome, Knip, TypeScript, tests/process tests,
   build, package smoke and installed synthetic qualifications. Record failures
   separately from unavailable live daemon/provider checks.
5. Pack locally, clean-install the tarball in a disposable downstream toolchain,
   verify UUID removal and run Klicker's production clean-bin profile resolver.
6. Produce a reviewable local branch/diff and qualification report. Publication,
   release version/changelog/prompt preparation, downstream published pin and
   hosted CI remain separate steps requiring the released artifact.

Suggested implementation commit: `fix(deps): remove vulnerable UUID via Dockerode 5`.

## Acceptance and rollback

- The manifest and lock agree; Dockerode 5 is used by the actual installed CLI;
  UUID is absent without an override or ignore.
- Real-library transport tests, existing gates and packed CLI proof pass, or
  concrete limitations are recorded without calling unrun checks successful.
- Downstream local profile planning preserves the same literal plan semantics;
  no unpublished version enters an active downstream manifest/lock.
- Rollback before release is a revert of the dependency/test change. After a
  future release, consumers can restore their prior exact lock, which restores
  the advisory exposure; no privileged controls are weakened.

## Progress

- [x] Isolated checkout, current base, unrelated work and open PRs inspected.
- [x] Primary release/advisory and registry metadata checked.
- [x] Manifest/lock update and graph inspection: Dockerode 4.0.9 -> 5.0.1,
  Docker modem 5.0.6 -> 5.0.7, UUID 10.0.0 removed; no other graph changes.
- [x] Real transport regression tests: 18/18 pass over Unix sockets, HTTP and TCP.
- [x] Docs policy, knowledge, Biome, Knip, TypeScript and production build pass.
  Biome reports one pre-existing unused-import warning and four informational
  template-literal suggestions in untouched files.
- [x] Full test command: 160 files and 2,927 tests pass. The 13 Linux zombie
  tests and process-helper shell tests are skipped on macOS; they are not live
  Linux qualification.
- [x] Packed CLI smoke passes from a temporary install and working directory,
  including actual network-client fixture proof (16 Docker calls, no mutations).
- [x] Synthetic installed capacity qualification passes (fixture coordinator and
  actual installed worker; not live provider/OOM qualification).
- [x] Installed synthetic controller and lifecycle qualifications pass. These
  use packed production code with closed fixture providers, not live provider
  or OOM qualification. Skill regression corpus and apply/manifest tests pass.
- [x] Read-only real daemon proof: container lists with `all:true/false` and an
  existing-network lookup succeed through production `docker.ts` with real
  Dockerode 5. No daemon objects or global state were changed.
- [x] Local packed downstream qualification: copied Klicker `51e8e725`, unchanged
  locked installer, five profile unions, clean executable rejection/acceptance,
  exact bounded build graph and 21/21 existing tests pass. UUID is absent.
- [x] Reviewable branch and qualification evidence prepared; release-dependent
  follow-up identified below.

## Security audit boundary

A read-only base/candidate audit comparison found exactly the UUID advisory
removed: 19 findings at the base, 18 in the candidate. The remaining findings
are identical module versions and advisory IDs in retained YAML 2.8.2,
Protobuf 7.5.4 / UTF8 1.1.0 and gRPC 1.14.3 dependencies (one critical, eight high,
eight moderate and one low). The production audit therefore exits nonzero;
this scoped preparation is not a clean full security audit. No overrides,
ignores, global installations or patched-version claims are used to hide that
remaining debt. A broader dependency refresh is a separate reviewed change.

## Downstream proof and release dependency

The local archive retains source version 0.5.4; it is **not** the published
0.5.4 package. Its SHA-256 is
`3505d70260952c66a3af315dce959027545d620936e313f8d5c7891e4fdbdc1a`.
The copied Klicker production installer clean-installed it with scripts disabled.
The fresh consumer graph resolved Dockerode 5.0.1, Docker modem 5.0.7,
gRPC 1.14.6, Protobuf 7.6.6 and YAML 2.9.1, with no UUID edges or packages;
that consumer audit returned zero findings. This does not replace the failing
audit of the older upstream source lock documented above.

The actual clean sibling `bin/devrouter` passed the production resolver, while
the direct `node_modules/.bin` path was rejected. All five selected/full profile
unions produced the expected literal resources and filters; unknown profiles
failed closed and plan outputs retained mode 0600. The selected build adapter
returned `bounded` / `bounded-profile` for manage+pwa with four exact filters,
without full fallback. This is local packed proof on macOS, not registry,
hosted Linux x64/ARM64, live routing or DevPod lifecycle evidence.

After a separately authorized reviewed upstream merge and fixed npm release,
update both Klicker CI pins: `.github/toolchains/devrouter/package.json` and its
generated npm lock, plus `.github/scripts/install-devrouter.sh`. Keep the local
minimum unchanged in that first change: PRs still consume trusted base-branch
CI tool bytes. Once the fixed planner reaches trusted `v3`, raise the local
`.devrouter.yml` minimum and matching current guidance in a later change.
An active downstream pin cannot be generated truthfully before the new published
release exists. No downstream source, monitor, CI flag, global installation,
package publication, merge or deployment changed during this preparation.
