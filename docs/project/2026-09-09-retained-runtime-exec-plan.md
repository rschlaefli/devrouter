# Restore tooling access after interrupted preparation

Status: approved reliability source scope; bounded planner review accepted with target correction.
Owner: main. Branch: rs/retained-runtime-exec. Target: main at a89f379.

## Outcome and authority

A running Devsy workspace must remain usable for tools after an interrupted
ensure has fully drained, even when current devcontainer configuration differs
from its retained running configuration. Restore canonical exec without restarting
services, recreating containers, changing ownership or claiming preparation succeeded.
Preserve the interrupted ensure result and never replay an uncertain exec.

The existing reliability roadmap authorizes this source fix, isolated fixtures,
checks, reviews, commits and draft PR delivery. This package is based on released
main so it can unblock consumers independently of unfinished capacity admission.
No consumer checkout, database, runtime or ownership record may be changed during
investigation. Applying a patched CLI to the waiting consumer is a separately
specified canary action after source review. No deletion or bootstrap replay.

## Execution contract

Admit recovery only for manual execution, running intent, recovering phase, prior
ensure INTERRUPTED and drained, no remaining worker, and fresh exact Devsy runtime
proof. An internal event flag records that proof was obtained for this request.
Keep history limits, identity deduplication, stop fences and capacity behavior.

Capture a transient provider context, registration ID/UID, canonical source path,
Docker endpoint/daemon, full container ID and exact source mount destination.
Prove a unique running primary and provider runner-label binding. Carry proof to
the worker and revalidate before command effect under existing workspace/provider
serialization. Do not treat config mismatch as permission to adopt another runtime.
Preserve Devsy argv, remote user, cwd and numeric/unknown outcome semantics.

Main owns proof/integration decisions and packed verification. A bounded executor
owns the settled predicate, proof plumbing and regression tests. Reuse existing
provider inspection helpers. If transport cannot retain target identity, stop
before execution and document the limitation; provider locks do not govern direct
external mutations. No stop-baseline capture or managed-state rewrite is part of exec.

## Acceptance

Tests cover recovery, undrained/live workers, stopped/parked intent, nonmanual
policy, missing proof, prior unknown exec, preserved history and duplicate identity.
Identity changes before dispatch must produce zero command launches. Packed CLI
fixtures prove one successful tooling command after failed ensure and retained
configuration/managed state/routes, nonzero exit handling and no replay. Run
repository checks, independent slice and final reviews, then draft PR and CI.
Reuse unchanged passing evidence. No live-provider claim from synthetic fixtures.

## Progress

Exact waiting consumer attribution was completed read-only: Devsy registration,
runner UID and full container identity agree with the exact mounted checkout.
Its manual journal has an interrupted/drained ensure with no worker; retained
managed profile is ready but configuration drifted and has no stop baseline.
Forced DevPod fails the intended provider identity comparison. The model currently
blocks exec after interrupted ensure. No supported immediate recovery command was
established; the consumer owner was informed to preserve its runtime and data.
Planner Boole identified the missing pre-exec provider/container proof. Main
accepted that correction and rejected use of unpublished capacity as the patch
base. The explicit delivery target is released main.


Main took over source implementation after the executor continued analysis without
an artifact following its narrowing checkpoint. The child was closed; no replacement
executor was started. The patch adds a narrow manual recovery predicate, transient
Devsy identity proof, worker transport and pre-launch revalidation. Named Devsy
execution preserves its remote user/workdir behavior; context is explicitly selected.
Devsy 1.16.2 source shows container-id mode omits those settings, so that fallback
is excluded. Direct external provider mutations remain outside Devrouter locking.

The installed synthetic regression reproduced the original blocked transition, then
passed with one command launch and exit code 7 while retaining source/generated
configuration, managed state, routes and the interrupted historical result. This
receipt is from a dirty development tree before the final context argument change;
clean committed qualification remains required. The focused source suite passes
84 tests, including replacement identity rejection and zero launches after a failed
proof. TypeScript, Biome and Knip pass. No consumer runtime or machine policy changed.
Independent committed-slice and integrated-final reviews and PR delivery remain open.


Advisor review identified that Docker observations alone do not prove Devsy runtime
selection. Main verified Devsy 1.16.2 NewContainerRuntime, LoadProviderConfig and
platform path resolution in upstream source. The correction reads only the selected
provider configuration for driver/command qualification and retains only allowlisted
registry provider name and DOCKER_PATH metadata. Recovery requires Docker and the
plain docker command; it never redirects custom commands or an Apple provider.
Capture and revalidation repeat this qualification. Unsupported recovery stays
blocked while ordinary exec behavior is unchanged. Configuration is never written
or returned in error output. Final review must include this provider-data boundary.


Final source at 6f1a37f passes 1297 unit tests in 92 files and clean packed CLI
qualification (dirty=false), including retained tooling access and no replay.
TypeScript, Biome, Knip, documentation policy, knowledge, package distribution smoke
and hooks pass. Simplifier finds no useful reduction. Slice reviewer verifies the
provider correction; main closes its schema-spelling question against Devsy 1.16.2
ProviderConfig JSON tags and SaveProviderConfig JSON serialization. Advisor's
runtime-alignment finding is resolved by qualification, without changing provider
configuration. Synthetic receipts and reviews are in docs/project/_local/reviews.
Integrated final review and draft PR/CI are the remaining delivery steps.
