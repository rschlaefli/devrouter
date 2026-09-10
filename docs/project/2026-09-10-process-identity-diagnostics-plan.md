# Actionable process-identity diagnostics

Status: delivered in [PR #77](https://github.com/rschlaefli/devrouter/pull/77) (draft, merge user-gated). Branch `rs/process-identity-diagnostics` from main `e5326b4`.

## Outcome

Lock acquisition keeps failing closed when process identity is unavailable, but the failure is now actionable. `processBirthIdentityWithCause` captures the failing inspection stage (procfs read error code, ps exit status, kill signal, or spawn error code) without echoing raw stderr; the acquire error names the activity, exact lock path, reproduction command (`LC_ALL=C ps -o lstart= -o command= -p <any-live-pid>`), and the permitted-host-context remediation, and states that no identity fallback was attempted. `devrouter controller` commands print the underlying cause on stderr as one capped line while the stdout `controller-unavailable` JSON contract stays byte-identical. Lock semantics are unchanged: owner records, stale reclaim, the fair queue, and the conservative liveness path (a live owner whose birth cannot be re-verified stays live) were not modified, and the identity check remains the first acquire step before any candidate or queue artifact exists.

## Evidence

- Focused tests: 21 across file-lock and controller-command suites, including three new lock-diagnostics cases (composed cause in the acquire error, ps stage detail without stderr echo, spawn-error precedence) and three new controller contract cases (stderr cause, stable stdout bytes, single-line 300-char collapse).
- Full suite: 1565 tests / 117 files green (Linux process-helper tests skipped on macOS by design). tsc, repo-wide Biome, knip, docs policy, knowledge checks, and tsup build pass.
- Review: slice-reviewer route `combo/glm-5.3-flash` max returned DONE_WITH_CONCERNS on `e5326b4..9b473d2` with zero correctness, data-integrity, security, protocol, or contract defects. Finding 1 (high, confidence 92): two direct-call tests lacked the established `/proc/` mock and would fail on procfs CI hosts. Fixed with the platform-neutral mock. Finding 2 (low): single-line collapse and cap are now tested with a multi-line, over-length cause. Finding 3 (low, cosmetic): a signal-killed ps now reports `ps was killed by signal <sig>` instead of `exited with status null on <sig>`.
- Review provenance: fresh-context read-only slice-reviewer child on the external Combo route; effective provider unknown per routing policy.
