# Devrouter roadmap

Status: active. This record contains open work and quality gates, not current product reference material.

Use the [documentation map](../README.md) for supported behavior, [AGENTS.md](../../AGENTS.md) for repository constraints, and the [decision records](../adr/) for durable rationale.

## Current direction — 2026-11-07

The [reliability acceptance roadmap](./2026-09-13-reliability-release-plan.md)
owns the whole outcome, remaining packages and proposed conditional batch.
[PR #180](https://github.com/rschlaefli/devrouter/pull/180) is merged at
`f6851b1f6d82a623b3cf2cb260a4f2903b1829bb`, with full reviewed-tree equality
and passing [main CI](https://github.com/rschlaefli/devrouter/actions/runs/42200684961):
3,547 tests and 13 packed cases across eight recovery families. Its guidance
corrections are merged and unreleased. Published 0.6.7 and installed 0.6.6 remain
separate delivery states; neither establishes current consumer recovery.

The human approved one conditional 0.6.8 release/adoption batch plus independent
read-only Control consumer intake. It reuses the merged source proof and explicitly
names inactive-chat wake-up, participating-client compatibility and replacement
of the unconsumed 0.6.7 adoption branch. The [release execution plan](./2026-11-07-release-0.6.8-plan.md) owns those effects;
consumer runtime attempts remain separately gated.
No owner has been messaged or runtime started by this realignment. `notLoaded`
is an inactive status; saved history being readable does not prove successful
message delivery, compatibility or runtime health.

The existing native goal is active after the user's resume. The corrected goal
brief is saved in the acceptance roadmap because available tools cannot edit its
text. Whole acceptance still needs a current-package owner-held useful-work,
retained-data, functional-neighbour and terminal-stop journey. The first 0.6.4
journey remains accepted historically; later population uncertainty remains open.
Maintenance/reset, shared tooling, preview/cloud and cleanup keep separate owners.

## Historical direction — 2026-11-05

The section below retains the earlier planning and approval record. Its former
current/draft/next-action and blocked-goal statements are superseded above.

The [reliability acceptance roadmap](./2026-09-13-reliability-release-plan.md)
owns current priorities, delivery layers and the remaining integrated canary,
host-suspend and consumer evidence. The earlier
[evidence and stop-recovery package](./2026-10-26-reliability-evidence-repair.md)
is delivered source with explicitly open live acceptance, not the next source fix.

The first owner-verified ordinary retained reconstruction is complete on 0.6.4.
The recorded consumer combination passed retained-storage and selected-data
checks, native/browser useful work, functional neighbour preservation and both
terminal stops. [Consumer draft #6652](https://github.com/uzh-bf/klicker-uzh/pull/6652)
contains inspected evidence. Broader consumer readiness and portability remain
open; the acceptance roadmap owns the exact limits.

The managed recovery-command rendering correction is merged in
[PR #176](https://github.com/rschlaefli/devrouter/pull/176) at `b61a8fae`, with
complete tested-tree equality and passing merged-main CI. Argument regressions
protect literal checkout paths, canonical executable names and existing variants.
[0.6.6](https://github.com/rschlaefli/devrouter/releases/tag/v0.6.6) is published
through [PR #177](https://github.com/rschlaefli/devrouter/pull/177) at `5931c00f`,
with complete tested-tree equality and passing candidate, merged-main and release
CI. Registry integrity and all 108 package files match the held tested bytes and
modes. The [release plan](./2026-11-02-release-0.6.6-plan.md) records its scope;
receiving-host adoption and consumer recovery retain separate acceptance.

The failed-transition guidance correction is merged through
[PR #178](https://github.com/rschlaefli/devrouter/pull/178) at
`d68891fd602b0e0a1bac9d568f80e43db659fad3`, with complete tested-tree equality
and passing [merged-main CI](https://github.com/rschlaefli/devrouter/actions/runs/41993417620).
It is released in [0.6.7](https://github.com/rschlaefli/devrouter/releases/tag/v0.6.7)
through [PR #179](https://github.com/rschlaefli/devrouter/pull/179), merged at
`f1e688d687f81edb18d1660a4e32b732fdd17f3e`. Merged-main and publication CI
passed; registry integrity and every shipped member match the held package.
Local installation is held because the named consumer-owner routes are unavailable
and participating-client compatibility remains unconfirmed. No owner notice or
receiving recovery is claimed.

The approved [recovery guidance matrix](./2026-11-05-recovery-guidance-parity-plan.md)
is delivered as [draft PR #180](https://github.com/rschlaefli/devrouter/pull/180)
in `trees/rs/recovery-guidance-parity`.
It corrects demonstrated report contradictions and qualifies eight bounded state
families through 13 actual packed public-command cells. The first candidate has
passing clean-tree CI; the PR owns the final correction review and latest CI. Its terminal is reviewed,
CI-green draft delivery; ready, merge and release are excluded. The existing
native goal remains blocked because its resume control is user-only; actual
human approval authorizes the source batch through available tools. The
acceptance roadmap retains the broader goal and consumer-selection gate.
A further receiving journey has no selected producing owner.
The first accepted 0.6.4 journey stays accepted, while current-resource health and
later-version consumer acceptance remain unproven. Retained maintenance/reset
keeps its separate capability and authority prerequisites. Shared tooling and
preview/cloud work remain independently owned.

[0.6.5](https://github.com/rschlaefli/devrouter/releases/tag/v0.6.5) shipped the
initial managed-startup guidance correction through
[PR #175](https://github.com/rschlaefli/devrouter/pull/175). Candidate, merged-main
and release CI pass; all 107 registry package files match the qualified bytes and
modes. Receiving-host adoption and consumer runtime acceptance remain separate.

Primary-only app replacement and newer-writer diagnostics are released in
[0.6.4](https://github.com/rschlaefli/devrouter/releases/tag/v0.6.4) through
[PR #173](https://github.com/rschlaefli/devrouter/pull/173). Merged-main and release
CI pass; registry integrity, all 106 shipped members and the approved local
installation match the tested package. Existing consumer owners received the
release notice and retain receiving-host adoption and runtime acceptance.

Retained-maintenance transport now has reviewed native evidence: 61 local
fake-child cases and 56 existing source controls pass. The acceptance roadmap
links the producing result. Trusted bootstrap, authoritative dependency/claim
adapters, durable restart no-replay and the consumer's complete read-only probe
context remain unqualified. Public implementation remains unapproved. Repeat
replacement and shared-tooling improvements remain proposed follow-ups. Release
or transport delivery does not close the integrated canary, host-suspend or
consumer evidence.

W2 — [Workspace resource accounting](./2026-08-16-workspace-resource-accounting-roadmap.md)
was delivered in [PR #30](https://github.com/rschlaefli/devrouter/pull/30),
merged as `f176a67` and released in
[v0.0.36](https://github.com/rschlaefli/devrouter/releases/tag/v0.0.36).
It is not the next implementation package.

W1 — [Packaged CLI command and release proof](./2026-08-15-packaged-cli-command-release-proof-roadmap.md) was delivered in [PR #29](https://github.com/rschlaefli/devrouter/pull/29) and merged into `main` at [f6718c6](https://github.com/rschlaefli/devrouter/commit/f6718c65a0e91dc6f7bb3b40ac1d328ab6a918cf); it added `pnpm test:package` and the required CI step after `pnpm build`. The registry-backed `npx` proof and any publication or release work remain separate scope.

## Validation gates

Required checks for behavior and documentation consistency:

1. `pnpm check:docs-policy`
2. `pnpm check:knowledge`
3. `pnpm check`
4. `pnpm knip`
5. `pnpm typecheck`
6. `pnpm test`
7. `pnpm build`
8. `pnpm test:package`
9. `node dist/devrouter.js -V --repo ./examples/routing`
10. `node dist/devrouter.js upgrade --repo ./examples/routing`
11. `node dist/devrouter.js setup --repo ./examples/routing --yes --json`
12. `node dist/devrouter.js doctor --repo ./examples/routing`
13. `node dist/devrouter.js repo inspect --repo ./examples/routing --json`
14. `pnpm routing:smoke` when Docker and local networking are available
15. `pnpm devcontainer:smoke` when DevPod is available
16. `pnpm devcontainer:smoke down` after live devcontainer verification

## Near-term roadmap

### Test-surface hardening

- Add platform-specific durability coverage where filesystems expose stronger power-loss test hooks.
- Close the macOS `/proc` process-test skip, which both the workspace cleanup
  and packaged-CLI packages carried as a residual concern. The
  [open-source release plan](./2026-02-08-open-source-release-plan.md) owns the
  matching macOS CI lane.
- Expand diagnostics tests with mocked Docker responses for edge-case guidance.
- Add command-level regression tests for documentation-backed behavior; the
  delivered installed-CLI smoke covers this at the distribution boundary.

### UX and operability

- Keep `devrouter workspace cleanup --repo . --inactive-for 30d --json` as the
  report-only managed-workspace inspection path, delivered in
  [PR #27](https://github.com/rschlaefli/devrouter/pull/27); preserve advisory
  activity, explicit `--check-merged` network scope, and fail-closed
  suggestions.
- Run the controlled live report-only `--check-merged` trial against a real
  forge. That package closed as `DONE_WITH_CONCERNS` with synthetic GitHub and
  GitLab CLI JSON as its only integration evidence, so the network path has
  never executed against a live forge.
- Add `devrouter app env <name>` for resolved dependency-environment inspection.
- Add a repository bootstrap helper from discovered Compose metadata to `.devrouter.yml`.
- Add `devrouter app doctor` for app-scoped diagnostics and remediation hints.

### Protocol and runtime expansion

- Evaluate additional TCP protocol support with explicit TLS requirements.
- Define the supported host-runtime TCP strategy in schema and manuals before implementation.

### CI and release hygiene

- Keep CI gates aligned with the validation gates above.
- Keep documentation and knowledge validation mandatory in CI.
- Ensure packaged assets include every upgrade prompt consumed at runtime;
  `pnpm test:package` proves this boundary on every required CI run.

## Known risks

- Shared TCP hostname multiplexing depends on TLS/SNI-capable clients.
- Host-process detection relies on platform-specific process and network inspection.
- Full smoke validation requires Docker, DevPod, and local socket/network access.

## Documentation policy

- Product manuals and active knowledge describe current behavior only.
- Dated project plans, ADRs, and solution records may retain labelled historical context.
- Upgrade and migration instructions stay in `CHANGELOG.md` and `upgrade-prompts/*.md`.
