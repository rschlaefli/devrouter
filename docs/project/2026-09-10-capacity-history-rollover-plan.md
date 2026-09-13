# Capacity-managed lifecycle history rollover

Status: approved reliability-roadmap continuation; supersedes the manual-only
rollover boundary recorded in `2026-09-08-lifecycle-history-rollover-plan.md`.
Owner: main. Branch: `rs/capacity-history-rollover`. Target: main.
Baseline: 85d184d (0.0.71).

## Outcome and authority

An enrolled (capacity-managed) checkout must keep accepting `ensure` and `exec`
beyond 128 settled operations. The previous boundary refused every later
command once a capacity-managed journal filled, which wedged the canary and
blocked the first activation run. This package extends the existing
conservative rollover to capacity-managed history without changing manual
semantics. Source implementation under the approved roadmap, including
focused verification, ordinary commit/push, and a draft PR for review. The
first delivery boundary is a reviewed draft PR with passing affected checks.

## Verified defect

The pure state model refuses an `operation-request` when
`executionPolicy !== "manual"` and the journal already holds
`RELIABILITY_MAX_ITEMS` (128) entries, and the rollover branch was reachable
only for manual policy. The reliability canary accumulated 128 entries from
repeated start/stop cycles, and the next admitted `ensure` was refused with
`Managed lifecycle transition is blocked.` Evidence: the durable record at
`~/.config/devrouter/reliability/3144ad32....json` held 128 entries with
`phase: idle`, `desired: stopped-by-user`, and a drained `COMPLETED`
operation. Replaying the model against that record returned `blocked` while
an equivalent manual record returned `accepted`.

## Correction and invariants

Both policies now reach the same rollover branch. The conservative guards are
unchanged: duplicate/conflict checks run first, only a settled, drained entry
in `COMPLETED`/`NOT_LAUNCHED`/`INTERRUPTED` is retired, the current operation
and the latest `ensure` result are never retired, exactly one entry is freed
per accepted replacement, and the request is refused when no entry qualifies.
Intent revision advances atomically with retirement, so every accepted
replacement carries a fresh fence and delayed events stay stale.

## Residual risk

The journal entry is also the durable deduplication memory for a capacity
request key: `prepareManagedLifecycleOperation` reuses the recorded
`operationId` for a repeated `requestId`, so retiring an entry releases that
memory. A retired entry is terminal and drained, and the CLI generates a
fresh request identity per invocation, so the released key can only be reused
by a retry of an already-settled request. Review should confirm that
assessment before merge; if a retry of a settled key must remain a no-op, the
retirement predicate needs a capacity-specific guard instead.

## Validation

- `reliability-model.test.ts` asserts capacity-managed rollover parity
(accepted, bounded at 128, oldest eligible entry retired) and that a
saturated capacity-managed journal still refuses when nothing is retirable.
- `reliability-liveness.test.ts` retains the saturated-journal and randomized
crash-walk liveness properties.
- `reliability-lifecycle.test.ts` retains the controller routing and worker
settlement coverage; the full suite, typecheck, Biome, knip, and the docs
policy checks must pass.

## Follow-up

After merge, re-run the bounded activation run on the canary: admitted
`ensure`, admitted `exec`, non-destructive `stop`, and a final stopped runtime
with zero routes.
