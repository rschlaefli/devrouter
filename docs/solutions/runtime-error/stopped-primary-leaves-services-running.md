---
module: managed-devsy-stop
date: 2026-09-05
problem_type: runtime_error
severity: high
symptoms:
  - "Devsy reports a stopped workspace while database or blob services still run."
  - "Repeating provider stop rejects the already-stopped primary."
root_cause: Provider workspace state is not proof that the complete Compose project stopped.
tags: [devsy, shutdown, ownership, compose]
---

# A stopped primary can conceal running services

Status: source correction verified locally; publication and live recovery remain separate.

## Problem

A partial shutdown leaves the primary container stopped while retained database
or blob services run. Devsy's stop command rejects a primary that is no longer
running. Repeating that command cannot finish this state. Removing routes alone
would conceal running services and would not meet shutdown's postcondition.

## Solution

[Managed stop](../../../src/core/managed-devsy-stop.ts) distinguishes provider
state from complete-project state. It captures exact IDs under the existing
workspace and provider locks, then checks registration, context, source mount,
generated-file provenance, configuration hashes and service membership. It
skips provider stop when the primary is already stopped and stops only captured
running service IDs after renewed proof. Containers and volumes are preserved.

Provider failure remains nonzero even if eligible residual shutdown succeeds.
This preserves the original failure and routes, allowing a later canonical
stop to finish route cleanup after complete stopped proof.

## Why complete inspection matters

A successful Docker inspect command can still provide incomplete evidence if
the caller silently filters malformed records. The strict
[inspection entry point](../../../src/core/devpod-environment.ts) requires full
requested/returned ID equality and an independent project relist. It rejects
missing or replacement containers, inconsistent states and transport failures.

The [regression tests](../../../src/core/__tests__/managed-devsy-stop.test.ts)
exercise partial shutdown, provider failures, ownership drift and failed exact
termination. The inspection tests independently exercise malformed and omitted
records. These are synthetic source checks; they do not prove a particular
consumer runtime has recovered.
