# Proposed external architecture-advisor input

Status: prepared locally; the advisor call was rejected before execution.
Approval would authorize sharing this document with the existing authenticated
Gemini 3.8 Flash High advisor through AGY. It contains unpublished design and
implementation details. It contains no credentials, raw command arguments,
environment values, customer data, or user records.

## Scope and verified context

Advise on interruption-safe lifecycle integration for Devrouter. Treat this
summary as the complete input. Do not read additional files, access external
systems, invoke tools, delegate, or modify files. Return advice only.

Current startup and both provider execution adapters hold a workspace lifecycle
lock through the entire operation. Managed repair additionally holds a global
provider mutation lock. Stop waits for the workspace lock before exact-owner
provider stop and route removal. Startup and preparation include synchronous
subprocess calls.

The existing atomic writer creates a private temporary file, writes and syncs
it, renames it, and syncs the parent directory. An error after rename can leave
persistence outcome uncertain. The existing runtime-state file records
container and profile facts; it is not a dispatch journal.

An unpublished pure reliability model now represents explicit start versus
attachment, intent revisions, runtime generations, controller epochs,
observation time floors, incident budgets, and positive stop proof before
capacity release. It requests dispatch persistence before launch and preserves
unknown completion without replay. Source validation passes; live reliability
is not qualified.

Legacy ensure is explicit startup, exec returns numeric status, and stop is
explicit. The Devsy wrapper currently treats a missing local provider exit
code as one. The DevPod wrapper parses a private remote completion marker but
rejects a local transport signal even after receiving that marker. Provider
and remote completion semantics need qualification.

## Proposed package

Add a durable intent and operation record per exact workspace under the existing
machine-state area. Repository ownership remains identity authority. This must
not become a global repository registry or a background service.

A short record lock would persist stop intent before waiting for lifecycle
work. Workers retain lifecycle-before-provider lock ordering and may briefly
acquire the record lock. Record-lock holders never wait for long lifecycle
work. Records omit raw arguments, environment, and output.

The next package must integrate real production calls and verify installed CLI
behavior with synthetic subprocess fixtures, then qualify isolated provider
cases. Controller observation, admission policy, parking automation, and agent
harness integration remain later obligations. No live target, provisioning,
fault injection, machine enrollment, consumer activation, merge, or release
is authorized by this consultation.

## Questions

1. Recommend a minimal linearization protocol for an effect claim racing with
   stop, without holding the intent lock through a long action. Explain how
   already-claimed effects and crash ambiguity are reconciled.
2. Recommend cancellation mechanics for synchronous provider calls. Compare a
   bounded owned worker process with converting the existing calls to async.
   Preserve worker identity and forbid replacement dispatch while remote work
   may remain alive. Do not propose another daemon.
3. Define evidence precedence when an authoritative remote completion marker
   conflicts with local transport loss or a signal. Distinguish explicit stop
   from automatic recovery; no uncertain operation may be silently replayed.
4. Explain how durable guarded execution could retain unenrolled one-shot
   compatibility. Identify any public-contract or activation decision that
   requires the user's ruling rather than inventing consent.

Return DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED, with a concrete
recommended protocol, rejected alternatives, and unresolved decisions. This is
architecture advice, not implementation approval or runtime proof.
