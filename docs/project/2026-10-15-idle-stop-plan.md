# Idle stop for managed environments

Status: approved 2026-10-15; implemented and qualified, in draft PR #138. Branch `rs/idle-stop`, worktree
`trees/rs/idle-stop`. Supersedes the unshipped idle slice (Slice 3) of
[Profiles, leases, and resource lifecycle](./2026-08-24-profiles-leases-resource-plan.md).

## Approval summary

**Why and what changes?** Managed devcontainer stacks keep running long after
anyone uses them. On 2026-10-15 two stacks untouched for 6–7 days held about
4.8 GB of Docker memory. `devrouter setup --devsy-inactivity-timeout 30m` looks
like it handles this, but it cannot. Devsy's idle daemon only stops a container
when it runs as the container's main process. Devrouter's compose layout
(`overrideCommand: false`, `command: sleep infinity`) makes it a background
process, so on timeout it exits and the container keeps running. Even as the
main process it would stop only the app container, leaving Postgres, Redis and
Hatchet, devrouter's routes and its lifecycle journal behind. It also counts
only SSH sessions as activity, so browsing the apps or running Playwright from
the host never counts.

This plan makes devrouter the single owner of idle stop:

1. A read-only `devrouter workspace idle` report that classifies each running
   managed environment as active, idle or unknown from several activity signals,
   including Traefik HTTP traffic.
2. An explicit `--stop` mode that stops idle environments through the same exact
   path as `devrouter stop <path>`, re-checking idleness inside the lifecycle lock.
3. An opt-in periodic trigger, installed by `devrouter setup`, that runs the
   stop mode every few minutes.
4. Devrouter stops forwarding Devsy's `INACTIVITY_TIMEOUT` and disables Devsy's
   own idle daemon, so only one mechanism decides.

**What stays unchanged?** `stop` stays non-destructive: no volumes, worktrees,
branches, owner records or data are removed, and the next `ensure` resumes the
stack. Nothing stops automatically unless the user opts in. Consumer
repositories keep `overrideCommand: false`. Parking, capacity admission and
consumer consent keep their current, unactivated contracts (ADR 0008). There is
still no global repository registry.

**What could change the decision?**

- *Trigger.* Devrouter has never installed a background job. Recommended: an
  opt-in macOS launchd agent created by `devrouter setup --idle-stop 30m` and
  removed by `--idle-stop off`. Alternatives: manual `workspace idle --stop` only,
  or a sweep inside the foreground controller (only runs while someone keeps
  `controller run` open).
- *HTTP activity source.* Recommended: read Traefik's existing stdout access log
  with `docker logs devrouter-traefik --since <threshold>` and take the newest
  request per checkout router. It needs no Traefik config change or restart and
  no state file, so the report stays read-only. Measured: `json-file` driver
  (5 × 20 MB rotation), 0.7 s for 30 minutes and 0.5 s for 24 hours (12k
  requests). A non-`json-file` driver makes HTTP evidence unknown. Alternative:
  Prometheus router counters, which need a static-config change, one restart of
  every routed stack and a counter snapshot written between sweeps.
- *Blind spots.* TCP traffic (Postgres or Redis through Traefik SNI or a published
  loopback port) is not observed. A person who only uses `psql` for longer than
  the threshold would see the stack stop. Unknown evidence never stops a stack.
- *Primary checkouts.* Recommended: include managed primary checkouts, with the
  same vetoes.
- *Smallest alternative.* Set `overrideCommand: true` in consumers and keep
  Devsy's mechanism. Rejected because it still stops only the app container
  (Postgres, Redis, Hatchet, routes and journal stay behind) and counts only SSH
  sessions, so a person browsing the apps would see the stack stop.
- *Pinning without the controller.* Today the only human keep-alive is
  `humanPinned`, which needs `controller run`, `observe` and `protection-pin`,
  and its documented contract requires session proof. Recommended: a separate
  idle-only keep-alive field written by `devrouter workspace pin <path> [--off]`
  under the journal lock with persisted-ownership revalidation and its own
  revision, so idle stop and parking consent never share state. `humanPinned`
  remains an additional veto. The alternative, letting the CLI write
  `humanPinned` without a session, changes the controller contract and its docs.
- *Forgotten browser tab.* A tab left open with polling queries or a dev-server
  reconnect loop keeps producing requests, so the stack never goes idle. The
  qualification measures this. If it happens, ignore a small evidence-based
  list of background paths (for example HMR and health endpoints).
- *Public contract.* `--devsy-inactivity-timeout` becomes deprecated: it warns
  and does nothing, and the stored `devsyInactivityTimeout` is ignored. Neither
  installs the launchd agent; only an explicit `--idle-stop` does. This needs an
  ADR (0012) and an upgrade prompt.

**How will we know it is done?** On a disposable Devsy-managed checkout with a
short threshold: an untouched stack is reported idle and stopped, with its routes
removed and journal intent `stopped`, and a later `ensure` resumes it. Browser
traffic, `devrouter exec` and a pin each keep it running. Unknown evidence and a
held lifecycle lock refuse. The open-tab behavior is measured and handled. The
launchd plist is generated, rewritten and removed correctly in a temp `$HOME`;
loading it is your step after merge. The full validation checklist passes.

**What does approval authorize?** Implementation on `rs/idle-stop`, local
commits, pushes and a draft PR, and disposable test runtimes created and deleted
by the qualification. Withheld: merge, release and npm publishing, installing
the launchd agent on this machine's real `$HOME`, and stopping any existing stack
that this work did not create.

## Execution details

### Evidence (2026-10-15)

- Devsy v1.19.0 `pkg/devcontainer/compose_up.go` builds the entrypoint
  `…; exec "$@"; <wait for agent>; exec devsy internal agent container daemon`.
  With `overrideCommand: false` the service command fills `"$@"`, so `exec`
  replaces the shell and the daemon line never runs as the main process.
- `cmd/internal/agentcontainer/setup.go` (`startContainerDaemon`) also starts the
  daemon as a background process whenever the workspace timeout is set. In
  container `default-fi-9290a-app-1`, `/tmp/devsy-0/devsy.daemon.streams` records
  `daemon error: timeout reached, terminating daemon` at 18:15:40, 30 minutes
  after the last activity touch. The container is still running six days later.
- `cmd/internal/agentcontainer/daemon.go` has no Docker or Compose call. Its only
  stop mechanism is its own exit. `shutdownAction` only gates whether the monitor runs.
- `/tmp/devsy.activity` is touched only by the SSH server (`--track-activity`,
  always set by `devsy ssh`) and the fleet server. `devrouter exec` uses
  `devsy ssh`, so it counts; Traefik traffic and `docker exec` do not.
- The Devsy docker provider currently has `INACTIVITY_TIMEOUT=2m` at provider
  level. Devrouter overrides it per workspace with the machine setting (`30m`).
  An image-based devcontainer, where the daemon is the main process, would be
  stopped after 2 minutes without SSH if devrouter stopped passing a value. So
  devrouter must pass an explicit empty value rather than omit the option.
- Traefik v2.11 already serves its API on the localhost-only `traefik`
  entrypoint and logs every request with the `@file` router name, which encodes
  the checkout path.
- Measured costs on the klicker `manage` profile: warm no-op `ensure` 21 s,
  `stop` 64 s, `ensure` from stopped 37 s.

### Binding contracts

- **Single owner.** Devrouter decides idle stop. Every devrouter-started Devsy
  workspace passes `--provider-option INACTIVITY_TIMEOUT=` (empty). Devsy's
  `ParseOptions` keeps the empty value, but whether the later option merge keeps
  it or falls back to the provider-level `2m` is unproven. Slice 1 proves it on a
  disposable workspace by reading `/tmp/devsy-0/devsy.daemon.*`. If empty falls
  back, devrouter passes `8760h` instead, which keeps the daemon from ever firing
  without touching the user's provider-level Devsy configuration.
- **Activity signals.** The newest positive signal wins:
  1. Traefik HTTP requests for any router owned by the checkout.
  2. `/tmp/devsy.activity` mtime in the exact app container, read with one
     `docker exec stat`, which does not itself touch the file.
  3. The checkout's most recent lifecycle operation in its reliability journal.
  4. Route `updatedAt` (existing cleanup source).
- **Classification.** `active` when any signal is newer than the threshold.
  `idle` only when every applicable signal is readable and older. Otherwise
  `unknown` with a reason. Only `idle` may be stopped.
- **Vetoes** (report as `protected` with a reason): an unsettled or queued
  lifecycle operation, a held lifecycle lock, `consumerProtection.humanPinned`,
  any live controller consumer session, a parked journal, or an environment
  not in a running state.
- **Stop path.** `--stop` calls the same supervised stop as `devrouter stop
  <path>`, after re-reading all signals and vetoes under the checkout's
  lifecycle lock. Any change to `active`, `unknown` or `protected` skips the
  checkout. One checkout's failure never blocks the others.
- **Discovery without a registry.** Candidates come from machine runtime state
  devrouter already owns or reads: published host routes, reliability journals
  under `~/.config/devrouter/reliability/` and the Devsy and DevPod registries.
  Each candidate must resolve to an existing checkout with a managed
  `.devrouter.yml`.
- **HTTP evidence window.** A Traefik container younger than the threshold, or
  logs that do not reach back that far, make HTTP evidence unknown rather than
  idle. Access-log lines are attributed only through exact `@file` router names
  owned by the checkout.

### Delegation map

Solo execution in the main session. The end-of-package simplification and final
review may be self-performed or delegated, and are recorded in Progress.

### Test portfolio

| Risk or behavior | Obligation | Seam | Distinct failure |
| --- | --- | --- | --- |
| Classification never returns `idle` with missing or stale evidence | add new | pure classifier unit tests | stopping a stack someone is using |
| Each signal source parses and attributes to the exact checkout | add new | source adapters with synthetic Traefik access-log lines, journal and stat output | activity credited to a neighbour |
| Vetoes and in-lock re-check skip changed checkouts | add new | `workspace idle --stop` engine with mocked lifecycle | race between report and stop |
| Stop uses the existing supervised stop path | extend existing | lifecycle supervision tests | a second, weaker stop path |
| Devsy timeout is passed empty | extend existing | `devsy-mutation` argv test | Devsy's daemon stopping half a stack |
| Launchd plist generation, environment, rewrite and removal | add new | setup unit tests on a temp `$HOME` | job that cannot find tools, or orphaned and duplicated jobs |
| Idle-only pin is written under the journal lock and vetoes stop | add new | journal store and idle engine tests | pin lost or bypassed |
| End-to-end idle stop, keep-alive and resume | qualification script | disposable Devsy checkout | only unit-level proof |

### Slices

1. **ADR and activity report.** ADR 0012 (devrouter owns idle stop; Devsy's
   timeout is disabled). Add `src/core/workspace-idle.ts` with signal adapters and the
   classifier, and `devrouter workspace idle [--repo <path>] [--idle-for 30m]
   [--json]`, read-only. Pass the empty Devsy timeout.
   Acceptance: unit tests above; live report on this machine lists the existing
   stacks with correct signal ages and no mutation.
2. **Stop mode.** `workspace idle --stop` with vetoes, in-lock re-check and
   per-checkout outcomes in JSON. Acceptance: engine tests; live run on a
   disposable checkout stops it, and `ensure` resumes it.
3. **Opt-in trigger and contract.** `devrouter setup --idle-stop <duration|off>`
   writes the machine setting and installs or removes
   `~/Library/LaunchAgents/dev.devrouter.idle-stop.plist` (every 5 minutes,
   logs under `~/.config/devrouter/idle/`). `doctor` reports the setting, the
   agent's presence and the last sweep result. `--devsy-inactivity-timeout`
   warns and does nothing. Add `devrouter workspace pin <path> [--off]`. The
   plist uses absolute paths to `node` and the devrouter entry point (launchd has
   no shell `PATH`, and Volta shims move on upgrade) and is rewritten by each
   `setup`. `setup` also records the resolved `docker` and `devsy` paths and any
   `DOCKER_HOST`/`DOCKER_CONTEXT` into the plist's `EnvironmentVariables`, and
   `doctor` reports a sweep that failed to resolve tools separately from one that
   found nothing idle. The sweep takes its own single-instance lock, because several 64 s
   stops can outlast the 5-minute interval. Update `docs/DEVCONTAINER.md`,
   `docs/GETTING_STARTED.md`, the bundled skill, `ai-prompt.ts` and the
   lifecycle knowledge concept, and the protection paragraph in
   `docs/DEVCONTAINER.md` for the new keep-alive field. Acceptance: plist
   generation, rewrite and removal tested on a temp `$HOME`; docs policy and
   knowledge checks. Loading the agent with `launchctl` touches the user's real
   launchd domain, so the live load is a user-run step after merge.
4. **Qualification.** `scripts/qualify-idle-stop.ts` on one disposable Devsy
   checkout with a 2-minute threshold covers: idle stop, keep-alive by HTTP
   request, keep-alive by `devrouter exec`, pin veto, unknown-evidence refusal,
   an open browser tab left alone for the threshold, and resume. Then the full validation checklist, simplification and final
   review, the changelog entry and the draft PR update.

### Verification

Run the repository validation checklist from `AGENTS.md`. Live checks use only
disposable checkouts created by the qualification and delete them afterwards.
The live report in Slice 1 is read-only and may run against existing stacks.

### Working context

- Prior design rules kept from the August plan: no CPU or memory sampling, a
  report before any stop, stop-only, no deletion.
- Klicker needs no change. Its launcher already uses `devrouter env` and
  `ensure`, which count as activity.
- The KlickerUZH adoption is a `.devrouter.yml` version bump after release, plus
  the user's own `devrouter setup --idle-stop 30m`.

## Progress

- 2026-10-15: investigation complete; plan drafted and revised after one advisor
  review (access-log source, launchd environment, separate keep-alive field,
  open-tab scenario); awaiting approval.
- 2026-10-15: approved by the user with all recommended decisions; Slice 1 started.
- 2026-10-15: Devsy v1.19.0 source closes the empty-timeout chain: a user-provided
  empty `INACTIVITY_TIMEOUT` resolves to `""` (`computeOptionValue`, kept by
  `keptByUserOrBefore`), so `containerInactivityTimeout` is empty and
  `agentcontainer/setup.go` skips the daemon. Deliberate deviation: the live
  proof moves to the Slice 4 disposable checkout. Journal file mtime stands in
  for the last lifecycle operation, because journal records carry no
  timestamps. Settled manual journals keep one consumer and one request, so
  those are not vetoes; capacity-managed policy is.
- 2026-10-15: Slice 1 complete. ADR 0012, `workspace idle` report and the empty
  Devsy timeout. Live read-only run from the built CLI took 2 s and reported
  both running stacks idle (last activity 7–8 days earlier) with all four
  signals readable. Running from source (`tsx`) reports every journal
  unreadable, because its `0.0.0-dev` version refuses journals written by newer
  releases; live checks use the build. Checks: docs policy, knowledge, check,
  knip, typecheck; full suite 2,879/2,880 with one timing flake in
  `controller-server.test.ts` that passes on three isolated reruns.
- 2026-10-15: Slice 2 complete. `workspace idle --stop` re-reads each idle
  candidate's evidence immediately before its stop, then
  `superviseLifecycle("stop")` runs an `assertStopIntent` hook inside the
  journal transaction that records the stop intent. The hook refuses when the
  journal revision moved since that read or a journal veto appeared. The slow
  evidence read stays outside the journal lock, because other writers wait at
  most 2 s for it. Deliberate deviation: the live stop-and-resume check moves
  to the Slice 4 qualification, so one disposable checkout covers both.
- 2026-10-16: Slice 3 complete. `setup --idle-stop <duration|off>` writes the
  launchd agent (absolute `node` and entry paths, tool `PATH`, `DOCKER_HOST` and
  `DOCKER_CONTEXT`) and reloads it with `launchctl bootout`/`bootstrap`; the
  sweep holds `~/.config/devrouter/idle/sweep.lock` and writes
  `last-sweep.json`, which the `global.idle-stop` doctor check reads. The agent
  state is the plist itself, so no new machine setting exists. The idle pin is
  a new `idleProtection` journal field with its own validator, writer and
  revision. `parseInactiveFor` moved to `src/core/duration.ts`, because setup
  needs it without loading the route modules. Plist generation, rewrite and
  removal are tested in a temp home with a fake `launchctl`; nothing was loaded
  into the real launchd domain.
- 2026-10-16: Slice 4 complete. `pnpm qualify:idle-stop <cli>` on a disposable
  Devsy checkout (60 s threshold, every sweep scoped with `--repo`) passed:
  Devsy's idle daemon absent, HTTP and `exec` keep it active, untouched becomes
  idle, a pin vetoes `--stop`, a browser tab left open on the example page
  still goes idle, `--stop` stops it and frees its routes, and `ensure` resumes
  it. The runtime was deleted afterwards. The first runs found two defects:
  Docker applies `--tail` before `--until`, so the coverage probe reported
  every window with recent traffic as unproven (fixed with a buffer-bounded
  read). Devsy also stops recording SSH activity once its timeout is disabled,
  so `exec` is observed through its journal write. The live unknown-evidence
  refusal stays unit-covered, because breaking Traefik's log on a shared
  machine would affect other stacks.
- 2026-10-16: final review (self-delegated `final-reviewer`, report under
  `_local/reviews/2026-10-16-idle-stop-final.md`). Accepted and fixed: coverage
  probe, `--yes` missing from documented `setup --idle-stop` commands, empty
  exec output counted as a missing activity file, the stored deprecated timeout
  never cleared, sweep log growth (the agent now prints only stop outcomes),
  the ADR wording, and two prose assertions. Declined: journal matching by full
  identity, because journal files are keyed by repository path alone, so a path
  has at most one record. Documented instead of changed: rerun setup after
  upgrading devrouter. Simplification pass: the diff was reread for removable
  code and nothing further was cut.
- Validation: docs policy, knowledge, check, knip, typecheck, build, package
  smoke, setup/doctor/inspect on `examples/routing`, and routing smoke passed.
  The full suite passes apart from the load-dependent `controller-server` timing
  flake, which passes in isolation. `pnpm devcontainer:smoke` needs the DevPod
  CLI, which this machine lacks; the Devsy qualification covers the live
  devcontainer path.
