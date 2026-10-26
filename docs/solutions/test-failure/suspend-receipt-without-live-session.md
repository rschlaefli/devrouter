---
module: host-suspend-qualification
date: 2026-10-26
problem_type: test_failure
severity: high
symptoms:
  - "A host-suspend qualifier reported success without proving a live session crossed suspend."
root_cause: A permissive wake-label prefix and missing precondition checks accepted unrelated post-wake state.
tags: [qualification, suspend, provenance, false-positive]
---

# A passing suspend receipt without a live session

Status: verifier corrected at source; fresh live qualification remains required.

The qualifier matched `Wake Requests` as `Wake`, selected the latest power-log
pair and inspected the session only afterward. A session invalidated before
sleep could satisfy every post-wake assertion. Rebuilding the CLI between
preparation and verification also left the receipt naming the preparation hash
while commands used different bytes.

Repeating verification or attaching more post-wake assertions cannot establish
the missing precondition. The receipt must be treated as insufficient evidence.

`scripts/qualify-host-suspend.ts` now parses the exact event column, selects the
first completed cycle after preparation, checks successful renewal inside the
30-second lease with no prior refusal, and captures the bundle digest before
startup. Preparation, heartbeat renewal and verification check that digest
around CLI calls; the checkpoint retains the original producer identity. The script is import-safe so synthetic logs can test those boundaries.
`src/core/__tests__/host-suspend-qualification.test.ts` covers false wake events,
stale/refused renewal and executable drift; a subprocess case verifies that
bundle mismatch refuses before external calls.

Source regressions establish that invalid evidence is rejected. Only a fresh
operator-observed run with the unchanged bundle and a healthy pre-suspend
session can establish the live contract. Preserve failed observations and avoid
substituting a later successful cycle for the first attempted one.
