---
module: preview-controller
date: 2026-10-25
problem_type: integration
severity: medium
symptoms:
  - "A new refresh command repeatedly failed while the original preview was provisioning."
  - "Later status requests and normal reconciliation stopped until the command aged out."
root_cause: Deterministic admission refusals escaped the inbox scan before command completion, reconciliation and status publication.
tags: [previews, commands, reconciliation, retries, lifecycle]
---

# A refused preview command blocked ongoing reconciliation

Status: source and synthetic regression verified. Live installation qualification is separate.

## Problem

A second explicit start can be refused when the remaining lifetime does not fit
its setup budget. The refusal is valid. Treating it as a transient scan failure
left that command unprocessed, so each recovery scan failed at the same place.
The original generation stopped progressing even though its own work remained valid.

## What did not work

Waiting for the command-age window to expire eventually removed the obstruction,
but could consume the original setup deadline. Swallowing every exception would
instead discard retryable state or transport failures. Tests that admitted both
starts at one unchanged clock missed the remaining-budget refusal.

## Solution

Use typed deterministic outcomes at the policy boundary. The controller records
`PreviewAdmissionRefused`, completes that command and still reconciles and publishes.
The engine's conditional update is pure, so a thrown refusal commits no partial
allocation state. State, transport and cleanup-in-progress failures remain retryable.

See [the controller](../../../src/core/preview/controller.ts:197),
[the lifecycle budget guard](../../../src/core/preview/lifecycle.ts:194), and
[the source change](https://github.com/rschlaefli/devrouter/pull/154).

## Prevention

The [controller journey](../../../src/core/preview/__tests__/controller.test.ts:237)
advances time, changes the source, requests a refresh and proves the refusal is
recorded while the original generation becomes ready. Preserve that elapsed-time
condition when refactoring. Test command disposition and ongoing work together;
a policy exception by itself is only half of the contract.
