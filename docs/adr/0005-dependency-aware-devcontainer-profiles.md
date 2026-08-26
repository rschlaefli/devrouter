# ADR 0005: Keep devcontainer profile dimensions independent

Status: Accepted

Context: A managed consumer devcontainer can contain application services,
optional infrastructure such as an AI gateway or mail catcher, and one or more
repository-owned development processes. Treating all of those resources as
routed apps forces unrelated services to start together and makes a route-free
capability impossible to express. The committed Dev Container configuration
also needs to remain useful to native Dev Container clients.

Decision: Extend `.devrouter.yml` with an optional `managedRuntime` registry for
base Compose services, profile-owned Compose services, and managed process
markers. Let each profile select `apps`, `devcontainerServices`, and `processes`
independently, with `*` as the per-dimension wildcard. Normalize comma-separated
selections into one sorted union per dimension. A profile that selects only a
service or process is valid and produces no routes or application process.

Managed `ensure` will later derive an effective same-directory Dev Container
configuration with only the primary service, base services, and selected
profile services in `runServices`. It will keep that generated file ignored and
runtime-owned, pass it to the provider before startup, and reconcile only exact
owned services and processes. The source Dev Container configuration remains
the native full-start configuration.

Why: Independent dimensions match the actual dependency graph, preserve native
tooling, and make LiteLLM, MCP, mail, and similar capabilities opt-in without
inventing application routes. A registry is explicit and reviewable; exact
ownership and a final route commit prevent a profile switch from widening to
unclassified or foreign runtime resources.
