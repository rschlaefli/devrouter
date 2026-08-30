---
type: Integration Contract
title: Routing and runtime contracts
description: Defines supported application runtimes, workspace transforms, TLS routing, dependencies, and route publication.
owner: repository maintainers
status: active
source_paths:
  - src/core/repo-config.ts
  - src/core/managed-runtime*.ts
  - src/core/devcontainer-profile.ts
  - src/core/workspace-ensure.ts
  - src/core/app-run.ts
  - src/core/docker-run.ts
  - src/core/routes.ts
  - src/core/route-publication.ts
  - src/core/host-routes.ts
  - src/core/traefik-route-health.ts
  - src/core/router.ts
  - src/core/tls.ts
  - src/core/status.ts
  - src/core/doctor.ts
  - src/core/output.ts
  - src/types.ts
---

# Routing and runtime contracts

## Configuration authority

`.devrouter.yml` is parsed strictly by `src/core/repo-config.ts:loadRepoConfig`. Unknown keys, invalid runtime/protocol combinations, malformed hosts/upstreams, invalid ports, missing dependencies, and dependency cycles are rejected. `src/core/__tests__/repo-config.test.ts` is the executable contract.

`src/core/repo-config.ts:loadRuntimeConfig` creates the runtime view used by run, exec, status, doctor, and open. `applyWorkspace` deep-clones the parsed config, namespaces routed hosts, substitutes `${WORKSPACE}` in proxy upstreams, and gives Docker routers workspace-unique names. It never writes these values back to `.devrouter.yml`.

## Runtime ownership

| Runtime | Process/container owner | Route behavior |
| --- | --- | --- |
| `host` | Devrouter starts the configured host command. | Detect the allowed listening port and publish an HTTP route tied to the owned process. |
| `docker` | Devrouter starts the configured Compose service and dependencies. | Discover mapped/routed ports and publish HTTP or TLS/SNI TCP routing. |
| `proxy` | An external process or managed devcontainer owns the upstream. | Publish only the declared `host:port`; generic app routing may target external upstreams, while managed `ensure` requires the exact checkout alias namespace. |
| `kind: dependency` | Docker Compose lifecycle through a routed app. | No direct route and no direct run, exec, or open target. |

`src/core/app-run.ts:runConfiguredApp` owns generic host, Docker, and proxy application startup. `src/core/workspace-ensure.ts:workspaceEnsure` owns managed devcontainer proxy reconciliation; do not substitute `app run` for it.

## Managed devcontainer profiles

Managed devcontainers have two supported views of the same source configuration.
Native Dev Container clients use the source `devcontainer.json` and its full
service definition. Managed `ensure` may instead select a profile from the
`managedRuntime` registry in `.devrouter.yml`. The registry names base Compose
services, optional profile services, and repository-owned process markers.

Profiles select `apps`, `devcontainerServices`, and `processes` independently.
The primary service and base services are always included. In a managed config,
omitting an optional dimension means that dimension is not selected; therefore
an app-only profile does not start optional infrastructure, and a capability-
only profile can publish no route. `*` selects the complete registry for that
dimension. Profiles without `managedRuntime` retain the app-only behavior.

The effective managed configuration is an ignored, marker-owned sibling beside
the source file. It changes only `runServices` and keeps relative paths resolved
from the same directory. Warm profile transitions retain the exact DevPod and
volumes, use no recreate or broad Compose down, and publish routes only after
the selected service, process, and readiness proofs pass. Status and doctor
expose desired, active, and drift state without environment values.

## HTTP, TCP, and TLS

HTTP routes use `*.localhost` hosts. TCP routes require a supported `tcpProtocol` and TLS/SNI so shared protocol ports can select the hostname-specific upstream. `src/core/route-publication.ts:ensureRouteInfrastructure` enables required entrypoints, refreshes certificate host coverage, and refuses TCP publication while TLS is disabled.

Loopback proxy upstreams are rewritten by `src/core/host-routes.ts:parseUpstream` to `host.docker.internal` because Traefik runs in Docker. Managed devcontainers should use devnet aliases instead; see the [consumer devcontainer contract](./consumer-devcontainer-contract.md).

## Dependencies and environment

`src/core/repo-config.ts:resolveAppDependencies` resolves the dependency graph. `src/core/app-run.ts:startAppDependencies` starts needed Docker dependencies, derives protocol-specific environment variables, applies configured `envMap` aliases, and returns ownership-aware cleanup. Secret-manager wrapping receives only named runtime environment values; secret material remains native environment state and must not be written to config or documentation.

## Route publication and recovery

`src/core/host-routes.ts:replaceHostRoutesForRepo` validates and replaces one exact repository/worktree route batch under a shared lock. `writeRouteGeneration` writes the JSON compatibility mirror first and the canonical Traefik file second; the canonical file carries encoded metadata for the same rendered generation. Reads validate metadata against YAML, migrate complete headerless legacy state, repair stale mirrors, and fail closed on corruption.

Route-state failure injection and concurrency coverage live in `src/core/__tests__/host-routes-state.test.ts`. Config/runtime combinations live in `repo-config.test.ts`; generic application and dependency behavior lives in `app-run-exec.test.ts`; Docker-label discovery lives in `routes.test.ts`.

Managed route replacement does not treat the generated file or an HTTP response
alone as proof that Traefik applied the new generation. An application may
legitimately return 404, which is indistinguishable from Traefik's unmatched-
route 404 at the route URL. `src/core/traefik-route-health.ts` therefore checks
that exact expected HTTP and TCP `@file` router names are present and exact
removed names are absent through the localhost Traefik API. Stop and rollback
do not report successful route cleanup until this removal proof passes.

Both checks request a bounded 1,000-router view for each protocol so Traefik's
default 100-entry page cannot hide a router. Absence in a full bounded response
is treated as incomplete proof. The checks allow a short hot-reload grace
period, serialize concurrent recovery through one machine-wide lock, restart
only the Devrouter-owned Traefik service once, and fail closed with a log
command when the expected generation still cannot be proved.

## Change guidance

When adding a runtime, protocol, dependency field, or route-state version, update parser types, runtime dispatch, output/doctor behavior, focused tests, current manuals, generated prompt/skill surfaces, and release adaptation guidance together. Use the [change map](./change-and-verification-map.md) for the complete gate.
