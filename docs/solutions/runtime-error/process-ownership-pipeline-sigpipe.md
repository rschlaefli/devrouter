---
module: managed-process
date: 2026-09-05
problem_type: runtime_error
severity: high
symptoms:
  - "An owned managed process is reported as foreign."
  - "A failed transition leaves a degraded record that ordinary ensure rejects."
root_cause: Early-exit grep closes an ownership pipeline before tr consumes a large process environment.
tags: [managed-process, pipefail, sigpipe, degraded-runtime]
---

# Large process environments cause false ownership failures

Status: source correction verified locally; installation and live recovery remain separate.

## Problem

The Linux process helper reads ownership markers from `/proc/<pid>/environ`.
An owned process can be reported as `foreign` when its environment exceeds the
pipe buffer. This can fail a profile transition and leave persisted degraded
state. The regression reproduces this error class, not every historical failure.

## What did not work

Repeating ordinary `ensure` does not repair a retained degraded record. `stop`
preserves that record and the retained containers. Removing ownership checks or
clearing the record would conceal the failure instead of establishing ownership.

## Solution

The ownership pipelines in [the process helper](../../../bin/devrouter-process)
use `grep -Fx ... >/dev/null` instead of `grep -Fqx ...`. Exact matching remains,
but grep consumes the full stream. With `pipefail`, early grep success had allowed
an upstream SIGPIPE to turn a successful marker match into pipeline failure.

[The Linux lifecycle regression](../../../scripts/test-devrouter-process.sh)
places matching markers before 64 KiB of synthetic environment data. It verifies
status, reuse of the same PID, and stop. The previous helper fails this case;
the corrected helper passes while preserving foreign-process refusal.

## Prevention and recovery

For ownership pipelines, inspect the status of every stage, not only the final
matcher. Exercise data larger than a pipe buffer when an early consumer exit is
possible. Keep process-group and fingerprint checks intact.

For existing degraded state, use the explicit guarded repair contract in the
[Dev Container manual](../../DEVCONTAINER.md). It validates retained ownership
and configuration before replay, and persists ready only after candidate checks.
Provider queue waits are separate: one machine-wide mutation lock serializes
provider actions, and a slow bootstrap can delay unrelated workspaces.
