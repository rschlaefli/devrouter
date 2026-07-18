# Getting started

Install Devrouter, prepare one machine, and prove the first routed application.
Use the [repository onboarding guide](./REPO_ONBOARDING.md) for dependency,
secret-manager, workspace, and production-like consumer integration details.

## Prerequisites

- macOS
- Docker daemon and Docker Compose v2
- Node.js 24 or newer
- `mkcert` for trusted HTTPS and TCP hostname routing
- pnpm when installing from this source repository
- DevPod when using the managed devcontainer workflow

Quick checks:

```bash
docker --version
docker compose version
node --version
mkcert --version
```

`devrouter setup --yes --json` also checks Docker, Compose, mkcert, DevPod, and
the target repository's Node/pnpm toolchain. Missing optional tools become
explicit remediation items.

## Install the CLI

Persistent published install:

```bash
npm install -g @devrouter/cli
devrouter --help
```

No-install agent prompt:

```bash
npx --yes @devrouter/cli init --repo /absolute/path/to/repository
```

Contributor install from this repository:

```bash
pnpm bootstrap
export PATH="$HOME/.local/bin:$PATH"
devrouter --help
```

`pnpm bootstrap` installs dependencies, builds the package, and installs the
local executable at `~/.local/bin/devrouter`.

## Prepare the machine

```bash
devrouter setup --yes
devrouter doctor --json
```

Setup creates Devrouter's managed files, the shared external `devnet` network,
the Traefik router, and local certificates when mkcert is available. It reports
missing external tools; it does not install a broad development toolchain.

Lower-level commands remain available when troubleshooting:

```bash
devrouter up
devrouter tls install
devrouter status
devrouter logs --tail 50
```

Traefik normally owns `:80` and `:443`. Activated TCP protocols also claim their
shared standard port, such as `:5432` for PostgreSQL.

## Prove the first route

In a repository with an existing development command:

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

Devrouter injects a free `PORT` plus `HOST=0.0.0.0` and
`HOSTNAME=0.0.0.0`, then publishes the detected listener. Replace `pnpm dev`
with the repository's real command.

In another terminal:

```bash
devrouter ls
devrouter doctor --repo .
```

Open `https://web.localhost`. The first route is complete when the application
loads, `devrouter ls` shows the expected endpoint, and doctor has no blocking
finding.

## If the first route fails

- Port conflict: inspect `80` and `443` with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- Default Traefik certificate: run `devrouter tls install`, then rerun the app.
- `502 Bad Gateway`: inspect `devrouter logs --tail 50` and confirm the process listens on the injected port and a reachable bind address.
- Slow application: set `hostRun.portTimeout` in `.devrouter.yml`; the default is 120 seconds.
- Docker reports no space: free Docker disk space, then retry the failed command.
- Next.js rejects the proxied host: configure the development-origin host setting supported by the repository's installed Next.js version.

`*.localhost` normally resolves to loopback without `/etc/hosts`; that file does
not support wildcard entries. Devrouter does not mutate system DNS files.

## Continue

- [Onboard an existing repository](./REPO_ONBOARDING.md).
- [Use the preferred managed devcontainer model](./DEVCONTAINER.md).
- [Run the routing example](../examples/routing/README.md).
- [Run the managed DevPod example](../examples/devcontainer/README.md).
- [Read release and adaptation history](../CHANGELOG.md).
