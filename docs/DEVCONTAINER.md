# Fronting a devcontainer with devrouter

The preferred way to use devrouter going forward. The **devcontainer owns the
environment**; devrouter is a thin **routing layer** that gives it a stable,
TLS-terminated `*.localhost` host on the shared `:443`.

Clean split of responsibilities:

| Concern | Owner |
| --- | --- |
| Toolchain, databases, auth mocks, app process, install, seed | the devcontainer |
| `*.localhost` hostname, HTTPS/TLS, shared `:443`, `:5432` SNI | devrouter |

This works with any devcontainer-spec runner (DevPod, VS Code Dev Containers,
`@devcontainers/cli`, Codespaces) — devrouter only needs a port to route to.

## 1. Publish the app from the devcontainer

Have the devcontainer publish the dev server on a host loopback port (compose
`ports:` or `forwardPorts`). For example, the app on `127.0.0.1:3000`.

> Avoid publishing host ports devrouter owns — `80`, `443`, `5432`, and the
> Traefik dashboard on `127.0.0.1:8080`. If your container also runs an auxiliary
> service (an OIDC mock, an admin UI), publish it on a different host port so it
> does not collide with the dashboard. `dev up` fails fast on a bound port.

## 2. Declare a proxy route in `.devrouter.yml`

```yaml
version: 1
devrouter:
  version: 0.0.20 # runtime: proxy requires >= 0.0.20
project:
  name: myapp
apps:
  - name: app
    host: myapp.localhost
    protocol: http
    runtime: proxy
    upstream: 127.0.0.1:3000 # the port the devcontainer publishes
```

No `hostRun`, `docker`, `dependencies`, or `secretManager` — a proxy app only
registers a route. Loopback upstreams (`localhost`/`127.0.0.1`/`0.0.0.0`) are
rewritten to `host.docker.internal` so Traefik (running in Docker) can reach the
port published on the host.

## 3. Bring up routing

```bash
dev up            # shared Traefik + devnet (one-time per machine)
dev tls install   # mkcert CA + certs for *.localhost (one-time; needs sudo once)
dev app run app   # registers the route -> prints https://myapp.localhost
```

`dev app run` for a proxy app writes the route and returns immediately — it starts
no process. The container owns start/stop. Re-running is an idempotent
re-register. The route persists until `dev app rm app`.

Open `https://myapp.localhost`.

## 4. Verify / tear down

```bash
dev ls                 # the proxy route shows status "active"
dev doctor --repo .    # proxy routes are never flagged as stale (they have no PID)
dev app rm app         # remove the route
dev down               # stop the shared router
```

## Notes

- The container can run with or without devrouter. Plain `http://localhost:3000`
  keeps working; the `*.localhost` host is the opt-in prod-like front.
- App URLs that must match the routed host (auth callbacks, `NEXTAUTH_URL`, OIDC
  issuers) need to point at `https://myapp.localhost` rather than `localhost:PORT`.
  If your auth flow is pinned to `localhost`, keep using `localhost` for it and
  treat the routed host as the shareable URL.
- You can mix modes: a `runtime: proxy` app fronting the container alongside
  `runtime: docker` TCP routes for databases devrouter still owns.
