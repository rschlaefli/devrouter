---
module: managed-process
date: 2026-09-05
problem_type: performance
severity: medium
symptoms:
  - "Application readiness expires while dependency builds are still running."
root_cause: A background development command also runs prerequisite builds, so process launch starts the readiness clock before applications can listen.
tags: [managed-process, readiness, preparation, locking]
---

# Background builds consume application readiness time

Status: source correction; consumer runtime verification remains pending.

## Problem

A development task runner can build package dependencies before starting its
selected applications. Launching that runner in the background does not mean
the applications have started. A readiness loop can spend its entire budget
waiting for compilation. Counting probe attempts also understates elapsed time
when each HTTP request has its own timeout.

## What did not work

Moving builds before the process helper would let them rewrite outputs while
an old owned development process still runs. It also repeats preparation when
the helper would reuse an unchanged process. Increasing probe counts obscures
the preparation delay and does not establish an elapsed deadline.

## Solution and prevention

The [process helper](../../../bin/devrouter-process) provides an opt-in
foreground preparation command under its existing lock. It stops a changed
owned group before preparation, skips preparation on reuse, and prevents launch
after preparation failure. Cancellation terminates the preparation group before
lock release. Commands must not daemonize or detach from that group.

The [process regression suite](../../../scripts/test-devrouter-process.sh)
checks reuse, replacement ordering, failure and cancellation with lock contention.
Consumers remain responsible for selecting only prerequisite builds, completing
dependency installation before cacheable builds, and measuring readiness by an
elapsed deadline. A passing synthetic task graph is not live application proof.
