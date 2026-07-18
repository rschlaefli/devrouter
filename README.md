# devrouter

Local-first routing for macOS development through one shared Traefik router.

Devrouter gives repositories stable `*.localhost` routes without manual port
juggling. HTTP applications share `:443`; PostgreSQL, Redis, MariaDB, and MySQL
can share their standard ports through TLS/SNI hostname routing.

## What devrouter owns

- One strict per-repository configuration file: `.devrouter.yml`.
- Machine setup, the shared `devnet` network, Traefik, local TLS, and route state.
- Host, Docker, proxy, and dependency-only application definitions.
- Exact-checkout DevPod lifecycle for primary and linked Git worktrees.
- Check-only diagnostics and JSON evidence for local and agent workflows.

Devrouter does not own application source, consumer toolchains, database data,
or repository-specific startup commands.

## Choose a runtime model

| Model | Use it when | Lifecycle owner |
| --- | --- | --- |
| `runtime: proxy` with a self-contained devcontainer | Preferred for reproducible repositories and parallel worktrees. | The devcontainer owns the environment; `devrouter ensure` owns exact-checkout reconciliation and routes. |
| `runtime: host` | The application should run directly on the host. | Devrouter starts the configured command and detects its port. |
| `runtime: docker` | Devrouter should start a Compose service or routed datastore. | Devrouter starts the selected service and publishes its route. |

The models can coexist in one repository. See the [managed devcontainer
contract](./docs/DEVCONTAINER.md) or the [repository onboarding
guide](./docs/REPO_ONBOARDING.md) before adapting an existing project.

## Five-minute first route

Install the published CLI and prepare the machine:

```bash
npm install -g @devrouter/cli
devrouter setup --yes
```

In a repository with a development command, initialize the config and add a
host application. Replace `pnpm dev` with the repository's real command.

```bash
cd /absolute/path/to/repository
devrouter repo init
devrouter app add \
  --name web \
  --host web.localhost \
  --protocol http \
  --runtime host \
  --command "pnpm dev" \
  --cwd .
devrouter app run web --yes
```

Open `https://web.localhost`. In another terminal, confirm the route and run
check-only diagnostics:

```bash
devrouter ls
devrouter doctor --repo .
```

For a repository that already has the managed devcontainer contract, the normal
startup path is simply:

```bash
devrouter ensure .
devrouter exec . -- pnpm seed
```

Use devrouter lifecycle commands for managed environments. Raw `devpod up`,
`stop`, or `delete` bypass ownership locks and exact checkout validation.

## Agent onboarding

Generate the canonical, non-mutating onboarding prompt from a target repository:

```bash
npx --yes @devrouter/cli init --repo .
```

`devrouter repo agents` writes the matching Devrouter section and bundled skill
into the consumer repository. Artifact writes from `devrouter init` require the
explicit `--write-agents` or `--write-skill` flags.

## Documentation

- [Documentation map](./docs/README.md) — choose the authoritative current manual or record.
- [Getting started](./docs/GETTING_STARTED.md) — install Devrouter and prove the first route.
- [Repository onboarding](./docs/REPO_ONBOARDING.md) — adapt a consumer repository and verify it.
- [Managed devcontainers](./docs/DEVCONTAINER.md) — canonical devnet, proxy, startup, and teardown contract.
- [Repository knowledge](./docs/knowledge/index.md) — architecture, ownership, lifecycle, and change guidance.
- [Domain context](./CONTEXT.md) — shared vocabulary consumed by Matt Pocock planning skills.
- [Contributor guide](./AGENTS.md) — source map, invariants, validation, and release checklist.
- [Examples](./examples/routing/README.md) — routing without a devcontainer; see also the [managed DevPod example](./examples/devcontainer/README.md) and [parallel workspace example](./examples/workspace/README.md).
- [Project records](./docs/project/index.md) — dated plans and roadmap state.
- [Release history](./CHANGELOG.md) and [adaptation prompts](./upgrade-prompts/) — versioned change guidance.

Run `devrouter --help` for the complete current command and option reference.
