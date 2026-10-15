# ADR 0012: Devrouter owns idle stop for managed environments

Status: Accepted; the read-only report is implemented, stop mode and the
opt-in trigger follow in the same plan.

Context: Managed devcontainer stacks keep running long after anyone uses them.
Devsy offers an inactivity timeout, but in devrouter's Compose layout
(`overrideCommand: false` with a `sleep infinity` keep-alive) its idle daemon
runs as a background process. On timeout the daemon exits and the container
keeps running. Even as the main process it would stop only the app container,
leaving Postgres, Redis and other services, devrouter's routes and its
lifecycle journal behind. It also counts only SSH sessions as activity, so
browsing the routed apps or running browser tests from the host never counts.

Decision: Devrouter decides when a managed environment is idle and stops it
through its own supervised stop path. Every devrouter-started Devsy workspace
passes an explicit empty `INACTIVITY_TIMEOUT`, which overrides any
provider-level or stored value and keeps Devsy's daemon from starting.
`devrouter workspace idle` classifies each running environment from several
signals: Traefik access-log requests through the checkout's exact `@file`
routers, the provider activity file in its containers, the last write of its
reliability journal and its route update time. An environment is `idle` only
when every applicable signal is readable and older than the threshold.
Unreadable evidence makes it `unknown`. Lifecycle work in progress,
controller-managed policy, parking and a person's pin make it `protected`.
Only `idle` environments may be stopped, and a stop re-checks the evidence
inside the checkout's lifecycle lock.

Why: One owner avoids two mechanisms racing to stop parts of the same stack.
Devrouter already owns the whole stack, its routes and its journal, and only
it sees HTTP traffic through Traefik. Fail-closed classification keeps a
missing log or a failed probe from stopping a stack someone is using.

Rejected alternatives:

- Set `overrideCommand: true` in consumers and keep Devsy's daemon. It still
  stops only the app container and ignores HTTP traffic.
- Sample CPU or memory use. Idle dev servers and databases keep a steady
  baseline, so usage does not separate idle from active.
- Count Prometheus router metrics. It needs a Traefik configuration change, a
  restart of every routed stack and a counter snapshot between sweeps, while
  the access log is already written.

Known limits: TCP traffic through Traefik SNI or a published loopback port is
not observed, so a person who only uses a database client needs the pin.

Revisit when Devsy's daemon can stop a whole Compose project and accept
external activity, or when Traefik gains a per-router last-request time.
