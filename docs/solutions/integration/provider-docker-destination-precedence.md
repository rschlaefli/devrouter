---
module: managed-network-allocation
date: 2026-09-09
problem_type: integration
severity: high
symptoms:
  - "An inventory endpoint can differ from the provider's effective Docker endpoint."
root_cause: Provider-resolved options override inherited Docker environment and may persist in the workspace.
tags: [docker, devsy, devpod, ownership, network-capacity]
---

# Inherited Docker selectors do not prove the provider destination

## Status and problem

Source qualification complete; real-provider runtime proof remains outstanding.
An allocator must inspect and create on the same daemon. Passing `DOCKER_HOST`
through a child environment does not establish that property for the qualified
Devsy and DevPod provider implementations.

## Source evidence

Devsy v1.16.2 and DevPod v0.6.15 Docker helpers append provider-resolved environment
after the inherited environment. Their workspace option resolver saves explicit
provider options into the target workspace. A globally declared option therefore
can still become a workspace-local override. Sources:
[Devsy Docker helper](https://github.com/devsy-org/devsy/blob/v1.16.2/pkg/docker/helper.go),
[DevPod Docker helper](https://github.com/loft-sh/devpod/blob/v0.6.15/pkg/docker/helper.go),
[DevPod workspace option resolver](https://github.com/loft-sh/devpod/blob/v0.6.15/pkg/options/resolve.go).

## What did not establish safety

Neither an inherited endpoint nor a provider option's `global` declaration proves
invocation-only behavior. A context name can also resolve to a changed endpoint;
a stable socket path can serve a replacement daemon. A successful fake echo
command proves argument transport, not the installed provider's precedence.

## Prevention

The [binding validator](../../../src/core/network-provider-binding.ts) requires
exact provider, context, definition, workspace-local endpoint and daemon identity.
The [evidence collector](../../../src/core/network-provider-inspect.ts) distinguishes
saved options from shared defaults and rejects unqualified definitions or versions.
A binding-only partial start remains an effect even without a Docker network.

[ADR 0009](../../adr/0009-preserve-compose-network-ownership.md) owns the approved
persistent-binding design. Synthetic fixtures protect the source contract; a
separately approved runtime experiment must establish installed-provider behavior.
Do not write live provider settings to test this lesson without that authority.
