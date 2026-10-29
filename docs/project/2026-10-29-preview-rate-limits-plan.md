# Bound Northflank preview API work

## Approval summary

The user approved a source-only correction after a Chat qualification hit Northflank HTTP429 and could not verify cleanup. The existing cleanup-only follow-up owns that environment, uses the frozen merged checkout, and must remain independent. This source package starts from main386937c19eb776bfbd1fa9317061aec7cba61ebf in the separate rs/preview-rate-limits worktree.

The provider will checkpoint completed prepare/source/credential phases in its existing effect journal. Waiting for activation will then observe that run without replaying completed phase reads. Final ownership, credential and application acceptance checks remain fresh. The transport will parse only bounded numeric quota headers and Retry-After, preserve cleanup capacity when quota is low, and signal a bounded deferral instead of sleeping or retrying a mutation. Per-generation ownership persists the deferral across controller restarts. Cleanup can use the reserved capacity but respects a real exhausted window. An uncertain mutation remains observe-only. The reserve is local protection from reported account capacity, not a guarantee against unrelated clients using the same account. Native expiry stays the independent backstop.

Acceptance requires synthetic request-count evidence while activation stays pending, no calls before a persisted reset, cleanup access to reserved capacity, and no duplicate writes after uncertain responses. Existing secret/ownership/freshness and stop/expiry tests remain binding. There is no new dependency, secret permission, paid allocation or live retry. Source commits, an ordinary task push and a draft PR are authorized; merge and release remain separate.

## Execution details

Approval mode: executable source batch; actual user reply agreed to the preceding source-only proposal. Main owns src/core/preview/providers/northflank.ts, northflank-api.ts, existing src/core/preview/__tests__/northflank.test.ts and docs/PREVIEWS.md. One independent approved Sol substitute critiques the frozen plan and reviews the immutable implementation with a separate simplification assessment.

Slice1: extend existing effect checkpoints and provider tests. Only record completion after validated successful run/capture or verified credential delivery. Fresh final verification rejects missing/changed credentials. Explicit refresh gets a new effect and therefore fresh phase verification. Acceptance: long pending activation performs only its bounded run/container checks.

Slice2: extend existing transport with request-scoped cleanup priority, reported remaining/reset tracking, bounded429/Retry-After deferral and a private ownership wait record. No account registry or credential fingerprint. Ownership waits distinguish reserve throttling from exhausted quota so stop can use remaining capacity. Missing/malformed headers use a conservative finite fallback. A rate-limited mutation is uncertain and never blindly retried. Acceptance: synthetic quota exhaustion, fresh-provider restart, cleanup reserve, cancellation and existing fencing.

Feature test portfolio: extend existing provider fixture for native pending activation/request counts and credential drift; extend existing transport tests for bounded headers,429,read/mutation behavior and cleanup-priority concurrency; extend existing ownership validation for deferral metadata. No content/snapshot tests.

Verification: focused provider tests, typecheck, full native Node24 suite, docs policy/knowledge/Biome/Knip, build/package smoke, staged data hygiene and focused Opengrep. Reuse unchanged controller and CI image tests where appropriate. No local app runtime needed.

## Progress

Root outcome: opt-in profile previews deploy admitted CI digests and remain cheap to operate and remove. Authorized terminal: reviewed source correction, normal task publication and draft delivery; no new paid test. First useful acceptance: ten pending activation observations add no secret-group reads and no repeated completed prepare/source observations. Blocker: current transport discards quota headers and throws a generic429; provider revisits completed phases on every observation. The failed live generation remains cleanup-pending under its existing owner.

Plan critique: approved Sol substitute Gauss accepted the frozen plan. Accepted refinements cover all outer teardown/fenced/absence paths, four checkpoints in the144-step bound, async cleanup priority, monotonic quota/exhaustion observations, fresh-client restart, readback429 and repeated cleanup deferral. All are part of implementation acceptance.

Implementation progress: four durable effect checkpoints eliminate completed phase and credential reads while activation waits. Synthetic proof requires exactly20GETs for10observations,zeroadditionalsecretreads, and terminalcredentialdriftstillrefusesreadiness. Quota headers use a100request cleanupreserve, scopedpriority and monotonic exhaustion; one privatewaitrecord survivesfreshclient and covers teardown/fenced/absent. Uncertain secretreadback neverreplaysaPATCH.95focusedtests pass before final broad checks; typecheck passed before the last added tests. No provider calls or changes to the frozen cleanup checkout have been made by this source package.

Verification before independent implementation review:95focusedprovider/transporttests and3370wholeNode24tests pass,13Linux-onlyskips. Docs-policy,knowledge,Biome,Knip,typecheck,buildandisolatedpackage smoke pass. Directinstalledexecutables were used after pnpm refused to reinitialize a shared dependency symlink; no dependency files changed. SixfocusedOpengrepfindings matchunchangedbaselinecode,zeroerrors/newfindings. Main diffinspection keeps allhunks within the approved source boundary. Substantivepackage remains the twoexistingprovider modules plus behavior regressions; no new production module ordependency. Nativequalification is not run and the existing cleanup owner remains separate.

Review correction: the first implementation review found two defects. Final verification now compares runtime credentials against freshly resolved expected values. Local quota refusals are distinguished from requests sent to the provider, including capacity changes during an ownership claim. New synthetic regressions prove nonempty credential drift is rejected and both creation deferral paths can stop without phantom resources. All 98 focused tests and 3,373 full-suite tests pass, with 13 platform skips; typecheck, formatting, build and package smoke pass. Independent correction verification remains pending.

The separate frozen cleanup owner completed recovery. Independent inventory proves the failed trial's owned resources are absent, and its cleanup follow-up is deleted. This source package creates no replacement environment. Actual charges remain unknown and existing conservative budget holds remain binding.

Compound capture: preserve the demonstrated distinction between a local admission refusal and an uncertain dispatched write in docs/solutions/logic/local-quota-refusal-is-not-an-uncertain-write.md. This adds documentation only. The package remains one cohesive internal provider repair, with no product primitive or new production module.
