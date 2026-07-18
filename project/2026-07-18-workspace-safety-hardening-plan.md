# Workspace safety hardening plan

## Goal

- Make `devrouter ensure`, lifecycle teardown, garbage collection, managed process reuse, and route publication fail closed on one exact checkout and runtime generation.
- Remove the remaining paths that can reuse, route, stop, or delete a different workspace after an identity race or stale local state.
- Ship a reviewed `0.0.35` release candidate and prove it against an isolated lifecycle smoke plus Klicker's existing worktree integration branch.

## Non-goals

- Do not change DevPod, Docker, Compose, or Traefik as product dependencies.
- Do not add a second workspace identity or consumer configuration field.
- Do not perform out-of-band deletion or repair of user worktrees, DevPods, routes, branches, volumes, or application data. Explicit product lifecycle behavior remains in scope through disposable tests and the approved Klicker worktree target; the Escape Room worktree stays untouched.
- Do not merge a PR, publish an npm package, or release `0.0.35` without explicit user authority.
- Do not resume Escape Room feature implementation until the downstream workspace gate passes.

## Identity

- Plan: `project/2026-07-18-workspace-safety-hardening-plan.md`
- Branch: `codex/workspace-safety-hardening`
- Worktree: `trees/workspace-safety-hardening`
- Base and target: `main` at `cf7626a`
- Downstream: KlickerUZH draft PR #5169 on `codex/worktree-lifecycle-hardening`
- Release candidate: `0.0.35`

## Verified starting state

- `0.0.34` is released and green across typecheck, docs checks, tests, Knip, GitHub CI, and the isolated workspace lifecycle smoke. The exact Volta binary at `/Users/rschlae/.volta/bin/devrouter` reports `0.0.34`; the Homebrew-first shell path still resolves an older `0.0.33`, so all proof uses an explicit executable.
- Exact Compose overlay/path, Git common-dir, workspace env, aliases, container identity, in-container Git identity, health, bounded recreate, and route cleanup are already enforced.
- Five residual seams remain: HTTP upstream ownership is weaker than TCP; the default managed-process fingerprint ignores adapter/environment drift; DevPod list-then-mutate is only protected by a per-repository lock; route metadata and Traefik configuration are written as two independent files; and file locks treat a reused live PID as the original owner.
- Klicker PR #5169 still uses the superseded image-installed helper and automatic `postStartCommand` contract from `0.0.30`.

## Decisions

- One machine-global DevPod mutation lock under devrouter's home serializes every start, recreate, stop, delete, and GC mutation. The exact `(DevPod id, source.localFolder)` owner is re-read and proved inside that lock immediately before any ID-based destructive action.
- Lock hierarchy is repository-local lock first, machine-global DevPod mutation lock innermost. No operation may acquire a lifecycle, ownership, route-state, or other file lock while holding the global lock. The global lock covers only provider list/revalidation plus `devpod up|stop|delete` and immediate post-mutation ownership readback; container readiness, routes, Git worktree changes, and ledger updates run after it is released. Waiters fail after a bounded 60 seconds with the live owner PID and activity.
- This lock coordinates devrouter processes. Direct `devpod` commands and older devrouter versions do not honor it; exact provider revalidation narrows that external race but cannot make DevPod's ID-only mutation API atomic. Current guidance therefore forbids bypassing `devrouter ensure|stop|workspace down|workspace gc` for managed environments. Exact provider deletion without worktree removal uses the explicit `devrouter stop <path> --delete` path through the same boundary.
- Lock ownership records include PID plus a stable process-birth identity. A live PID with a different birth identity is stale and reclaimable; legacy `pid:uuid` records remain readable for one release and are conservatively treated as live.
- Every proxy upstream published by checkout-aware `ensure` must match the exact target's resolved alias namespace, regardless of HTTP or TCP. Generic `app run` proxy routing remains available for intentionally external upstreams.
- Managed process reuse fingerprints the exact command argv, workspace identity, exact managed-adapter file bytes by SHA-256, and variables explicitly named by `DEVROUTER_PROCESS_FINGERPRINT_ENV`. The helper validates and C-locale-sorts unique names, reads raw values from its environment rather than argv, distinguishes unset from empty, NUL-encodes the typed fields, and computes one SHA-256. It rejects secret-like names (`SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `API_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, names ending in `COOKIE`, and names containing `COOKIE_VALUE`). Secret changes therefore cannot alter the fingerprint or create a stored verifier. Volatile helper paths, PIDs, shells, and undeclared environment variables do not cause churn.
- The Traefik dynamic file becomes the single crash-consistent route artifact: an atomic same-directory write carries both the rendered Traefik document and a versioned encoded devrouter metadata header. While `0.0.34` writers remain supported, validated JSON is a mandatory compatibility mirror but never a second authority for a header-bearing file.
- Commit order is compatibility JSON first, canonical dynamic file second. Each stage uses a same-directory temporary file, file `fsync`, atomic rename, and parent-directory `fsync`; a JSON-stage failure aborts before the canonical file changes. A valid metadata header is authoritative even when JSON differs. A headerless dynamic file is a legacy-writer generation, so `0.0.35` reads JSON, validates it, and atomically migrates both rendering and metadata. Thus a completed `0.0.34` write is recoverable, while interruption after the new JSON stage leaves the prior canonical generation authoritative to `0.0.35`.
- Record the machine-global mutation boundary and the single-artifact route transition as minimal ADRs because both are surprising, cross-cutting, and costly to reverse.
- Existing configuration and workspace ownership record schemas stay compatible. No consumer migration is required beyond adopting the already-released managed adapter contract.

## Skill and review routing

- Delivery: `$rs-sliced-development-workflow`.
- Consumer validation: repository `devcontainer-onboarding` guidance and Klicker's `klicker-environment-doctor` / `klicker-testing-verification` workflow.
- Per-slice: separate implementation review and simplification agents using the workflow review rubric.
- Finish: `$security-review`, independent branch review, `$thermo-nuclear-code-quality-review`, and `$rs-mr-description-writer`.

## Independent plan review

- Reviewers: two independent collaboration agents, 2026-07-18; source-grounded plan review only.
- Accepted blockers: define mixed-version route-writer recovery; make compatibility JSON mandatory before the canonical write; specify durable write steps; document repository-lock then global-lock ordering, bounded wait, post-mutation proof, and the external direct-DevPod boundary; define the fingerprint payload, allowlist, secret-name rejection, SHA-256, and missing-versus-empty encoding.
- Accepted cleanup: mark Klicker's old contract/evidence historical, pin downstream proof to one exact branch-built executable, correct the residual seam count, and distinguish the exact Volta `0.0.34` binary from the older Homebrew-first shell path.
- Result: go for implementation after revisions; no supported finding was rejected.

## Slice 1: Unforgeable lock ownership and global DevPod mutation serialization

- Do: extend file-lock records with process-birth identity and safe legacy parsing; reclaim a PID-reuse lock without displacing the original process instance.
- Do: add one machine-global DevPod mutation lock and route `ensure` start/recreate, workspace stop/down, and GC delete through it.
- Do: move exact ID/path revalidation into the locked operation; after `up`, prove one exact owner; after `stop`, prove the same exact owner remains; after `delete`, prove both ID and path are absent. Fail when an ID disappears unexpectedly, changes source path, becomes duplicated, or is newly claimed by another checkout.
- Check: focused file-lock and lifecycle tests cover original owner, PID reuse, malformed/legacy records, same-ID reassignment, exact pre/post ownership, and all start/recreate/stop/delete/GC callers. One real cross-process test proves machine-global serialization; shared-boundary options prove the 60-second bound; caller event-order tests prove provider mutation precedes route, Git, and ledger mutation without acquiring repository locks beneath the global lock. This compact matrix replaces brittle pairwise concurrent-command mocks while preserving the same lock and ordering guarantee.
- Check: fastest relevant typecheck and tests, then review, simplification, rerun, progress update, and commit.
- Commit: `fix(workspace): serialize exact DevPod ownership mutations`.

## Slice 2: Exact upstream and managed-runtime identity

- Do: enforce the resolved workspace/checkout alias namespace for every HTTP and TCP upstream used by `ensure` before DevPod or route mutation.
- Do: hash the managed adapter on the host; pass its SHA-256 into the exact validated container; add the validated `DEVROUTER_PROCESS_FINGERPRINT_ENV` contract and SHA-256 payload construction to the helper.
- Do: strengthen static diagnostics so a devcontainer wired to devrouter lifecycle patterns cannot silently pass as unmanaged when its marker/helper contract is missing; truly custom unmanaged devcontainers remain supported.
- Check: tests prove foreign HTTP/TCP aliases fail before mutation, exact aliases pass, adapter/allowlisted-origin drift restarts an owned group, stable inputs reuse it, secret and undeclared variable changes do not affect it, secret-like allowlist names fail, state/logs contain no payload values, and unmarked legacy patterns are actionable failures.
- Check: Linux helper regression, focused TypeScript tests, review, simplification, rerun, progress update, and commit.
- Commit: `fix(ensure): bind routes and processes to runtime identity`.

## Slice 3: Single-artifact crash-consistent route state

- Do: add a versioned metadata header to the Traefik dynamic file and atomic durable replacement in the same directory.
- Do: read canonical route metadata from that file, migrate a headerless legacy generation from validated JSON, and regenerate the compatibility mirror after canonical success.
- Do: fail closed on invalid canonical metadata; never silently replace corrupted state with an empty route set.
- Check: failure-injection tests cover JSON-stage failure with no canonical change, interruption before canonical rename, after canonical rename, corrupt metadata, legacy migration, concurrent writers, Traefik document equivalence, and `0.0.35 write → simulated 0.0.34 JSON plus headerless YAML write → 0.0.35 read/migrate`.
- Check: host-route and route-publication suites, review, simplification, rerun, progress update, and commit.
- Commit: `fix(routes): make published route state crash consistent`.

## Slice 4: Documentation, release candidate, and upstream proof

- Do: update current product docs, agent skill, solution guidance, CHANGELOG, upgrade prompt, examples, and version surfaces for `0.0.35`; keep migration history out of current-state docs.
- Do: create or update a draft PR whose title/body cover the whole branch and explicitly state the downstream release dependency.
- Check: docs policy, formatter, Knip, typecheck, full tests, build, setup/doctor/inspect, route smoke, and isolated cold/warm lifecycle smoke.
- Check: final code-level security review, independent whole-branch review, and strict maintainability review; resolve or explicitly defer every supported finding.
- Check: validate the exact branch-built CLI with `node /Users/rschlae/Git/personal/devrouter/trees/workspace-safety-hardening/dist/devrouter.js`; record its source SHA and `-V` output, and use that same executable for every Klicker cold/warm command after the consumer adopts the `0.0.34` managed contract.
- Commit: one release-artifact commit following the repository checklist, proposed `chore(release): prepare devrouter 0.0.35`.

## Downstream gate

- Klicker PR #5169 removes the image helper and `postStartCommand`, marks its adapter managed, requires `DEVROUTER_PROCESS_HELPER`, and makes `devrouter ensure .` the only documented startup route.
- The branch-built `0.0.35` CLI must cold-start and warm-reuse that exact worktree, prove DevPod source and in-container Git path, publish only exact namespaced upstreams, exercise every routed endpoint, and pass delegated browser login.
- Do not tag, publish, or release `0.0.35` before the Klicker migration commit and downstream proof pass; those gates still do not grant publication authority.
- Escape Room work remains untouched until this gate passes. Its dirty files and existing legacy routes are preserved.

## Progress

- Current: Slices 1-3 are committed as `f34ee0d`, `0789ff1`, and `01046c9`; durable solution guidance is refreshed in `5532a82`; the reviewed `0.0.35` release artifacts are committed in `1f5b558`. Static setup/doctor/inspect, routing, disposable cold/stop/warm/dirty-rejection/GC lifecycle, and Linux managed-process smoke passed from that release candidate. Final security review found and fixed reversible macOS command-line storage in lock records by hashing the portable process-birth verifier. The thermonuclear findings are implemented: provider mutations now use central action-specific APIs, runtime helper and adapter delivery share one implementation, and host-route and ownership state share one durable atomic-file writer. The formatter, typecheck, Knip, documentation policy, production build, package dry-run, and all 507 tests pass on the stable final-gate diff. The independent specification review and final thermonuclear maintainability re-review are READY; Opengrep reports only the eight unchanged pre-existing findings.
- Next: commit the reviewed final-gate cleanup, rerun the full static/package/live proof on that exact commit, then publish the draft devrouter PR and begin the Klicker downstream migration.
