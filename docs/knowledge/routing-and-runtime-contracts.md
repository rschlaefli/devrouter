---
type: Integration Contract
title: Routing and runtime contracts
description: Defines supported application runtimes, workspace transforms, TLS routing, dependencies, and route publication.
owner: repository maintainers
status: active
source_paths:
  - src/core/repo-config.ts
  - src/core/app-run.ts
  - src/core/docker-run.ts
  - src/core/routes.ts
  - src/core/route-publication.ts
  - src/core/host-routes.ts
  - src/core/router.ts
  - src/core/tls.ts
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

## HTTP, TCP, and TLS

HTTP routes use `*.localhost` hosts. TCP routes require a supported `tcpProtocol` and TLS/SNI so shared protocol ports can select the hostname-specific upstream. `src/core/route-publication.ts:ensureRouteInfrastructure` enables required entrypoints, refreshes certificate host coverage, and refuses TCP publication while TLS is disabled.

Loopback proxy upstreams are rewritten by `src/core/host-routes.ts:parseUpstream` to `host.docker.internal` because Traefik runs in Docker. Managed devcontainers should use devnet aliases instead; see the [consumer devcontainer contract](./consumer-devcontainer-contract.md).

## Dependencies and environment

`src/core/repo-config.ts:resolveAppDependencies` resolves the dependency graph. `src/core/app-run.ts:startAppDependencies` starts needed Docker dependencies, derives protocol-specific environment variables, applies configured `envMap` aliases, and returns ownership-aware cleanup. Secret-manager wrapping receives only named runtime environment values; secret material remains native environment state and must not be written to config or documentation.

## Route publication and recovery

`src/core/host-routes.ts:replaceHostRoutesForRepo` validates and replaces one exact repository/worktree route batch under a shared lock. `writeRouteGeneration` writes the JSON compatibility mirror first and the canonical Traefik file second; the canonical file carries encoded metadata for the same rendered generation. Reads validate metadata against YAML, migrate complete headerless legacy state, repair stale mirrors, and fail closed on corruption.

Route-state failure injection and concurrency coverage live in `src/core/__tests__/host-routes-state.test.ts`. Config/runtime combinations live in `repo-config.test.ts`; generic application and dependency behavior lives in `app-run-exec.test.ts`; Docker-label discovery lives in `routes.test.ts`.

## Change guidance

When adding a runtime, protocol, dependency field, or route-state version, update parser types, runtime dispatch, output/doctor behavior, focused tests, current manuals, generated prompt/skill surfaces, and release adaptation guidance together. Use the [change map](./change-and-verification-map.md) for the complete gate.
