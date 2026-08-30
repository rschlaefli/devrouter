# ADR 0007: Keep CI profile planning repository-owned

Devrouter resolves profiles, validates a strict repository contract, and emits
named arrays of literal bindings, but it never interprets those binding names or
executes them. Consumer repositories own contract values and launchers because
putting build-tool commands in `.devrouter.yml` would couple local runtime
identity to CI providers and make Devrouter a workflow engine; returning only
route metadata would not identify repository build packages or CI readiness
addresses.
