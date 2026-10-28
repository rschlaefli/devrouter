# Reuse CI images in remote previews

## Approval summary

Status: executable source package requested by the user on 28 October 2026. The user selected frontend variants keyed by commit and complete public configuration, and approved independent GPT-6.1 Sol reviews because both exact Opus routes failed before a verdict.

Explicit preview commands freeze the commit, profile and generation. Devrouter resolves compatible immutable images from successful CI and coordinates only missing targets. Northflank consumes the resolved images. The application code keeps its existing configuration contract; no preview fixture behavior is added to it.

This source package permits task commits, ordinary task pushes and draft PR delivery. It does not permit publication, merge, release, credential changes or a replacement paid pilot. The previous pilot cutoff has passed. Native runtime architecture and actual image deployment without a provider build require separate bounded live acceptance. Preserve UZH ingress, opt-in updates, ownership, expiry and the existing spending ceiling.

## Execution details

### Binding contracts

A resource selects exactly one source build, immutable image, or logical CI image target. Repository configuration owns target mappings. One generic image backend accepts canonical requests and returns validated receipts; it is independent of forge and deployment APIs. An installed resolver command is an operator-reviewed implementation of that backend, with a bounded shell-free JSON protocol and explicitly mapped credentials. Candidate code never receives controller or pull credentials.

Successful receipt admission binds repository, trusted producer revision, CI run and attempt, actual checkout revision, logical target, platform, complete configuration digest and immutable registry digest. Required source CI and digest-bound scan evidence remain mandatory. Empty draft evidence, merge-SHA substitutions, stale attempts and platform/configuration mismatches fail closed. Helper reuse requires both current input fingerprints and verified producing CI.

Admission freezes generation and source before image preparation. Engine reconciliation owns image waiting before native deadline/deploy effects, using the existing state store, lease and once-write journal. Image waiting is bounded independently; native setup starts once images are admitted. Updates retain existing expiry. Stop, close, expiry and superseding operation fences prevent late activation. An uncertain dispatch is observe-only, including after a lease expires; absence is never permission to dispatch again. A push/publication cannot create or update a preview.

Northflank derives public configuration from deterministic generation/resource names without allocation. It binds explicit runtime platform and existing scoped registry pull-credential IDs. Resolved image graphs emit no Build or BuildService nodes. Platform availability must be independently qualified before live use.

### Ownership and slices

Execution mode: standard. Main owns lifecycle, installation, credentials, provider integration and final evidence. Settled image validation and CI script work may use bounded executors with disjoint write sets. Each substantive committed slice receives independent Sol simplification and risk review; the integrated package receives a final Sol review.

1. Generic image request/receipt contract and backend, manifest mapping and meaningful contract tests. Acceptance: immutable exact-source/config/platform admission; missing/shared targets; no build dispatch on a cache hit.
2. Engine image wait and Northflank image-only integration. Acceptance: durable once dispatch, uncertain outcome recovery, stop/update/expiry races, separate timing, scoped private registry binding and zero native build nodes.
3. Klicker selective dispatch in the existing image workflow and inventory/cache/scan helpers. Dispatch freezes exact source SHA, targets, platform, canonical configuration and correlation. Native runners only. Preview cache writes are isolated from trusted staging caches and preview tags do not move staging releases. Backend/migrator ordering supports reused migrators. Frontend variants reuse the existing build-environment validator; helper targets deduplicate the fixtures image.
4. Integrated verification, source delivery and exact live-test proposal. Actual live image deployment and warm provisioning timing remain blocked until separately approved; offline compilation is not deployment proof.

### Verification

Use repository-native checks and tests. Test the consequential seams: duplicate and uncertain dispatch, source/config/platform/receipt rejection, shared targets, OCI attestation filtering, private credential boundaries, update/stop/expiry fencing and zero provider builds. Retain existing qualification flags and source checks. Measure build waiting separately from provisioning. Existing observed cached CI build steps are not cold-build benchmarks.

## Progress

Root outcome: explicit profile previews reuse successful CI work instead of rebuilding on Northflank.
Authorized terminal: reviewed source implementation, ordinary task publication and draft delivery; report remaining native qualification honestly.
First useful acceptance: an existing compatible digest normalizes into a provider graph with zero provider build nodes and zero CI dispatch.
Existing evidence: current Klicker draft publishes no images; staging backend ARM64 and MCP AMD64 manifests verified. Selected Zurich runtime architecture remains unproven. No replacement allocation or publication has started.
Planning critique: Sol requested engine-owned waiting, executable selective CI and explicit provenance trust; all accepted. Corrected critique APPROVED by the same independent Sol reviewer; no material planning blockers remain.


Execution update: slices1–2 implemented on the task branch. Generic receipts and manifests passed independent Sol review after a constructor-name correction. Engine/provider review found once-only clock and abandoned-deadline defects; regressions cover both and a superseding initial revision. The exact final guard was closed through main verification within the bounded correction cycle. The independent simplifier reductions were applied. Whole Devrouter host suite passed3345tests before the final small clock correction; current preview suite passed224tests before the final superseding guard, whose22engine tests pass. Build and package smoke pass. Focused Opengrep found only unchanged findings in existing provider/planner/test code. A container-backed consumer hook is being prepared; no cloud allocation or image publication has run.
