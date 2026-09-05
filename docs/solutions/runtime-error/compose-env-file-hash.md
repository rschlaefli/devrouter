# False configuration drift with Compose env_file

Status: source correction verified; publication and live recovery pending.

Compose 5.1.2 can produce different hashes for `config --hash` and the container
label even when configuration is unchanged. The hash command omits service
`env_file` resolution. Docker tracks the regression in
<https://github.com/docker/compose/issues/14001>.

Render the complete recorded Compose model with `config --format json`, then
hash that resolved model through stdin with `--no-interpolate`. Keep the same
project identity and working directory. Suppress stderr and retain the resolved
model only in bounded process memory; it can contain credentials. Do not write
it to a temporary file, logs, diagnostics or a review artifact.

Read-only qualification matched retained app hashes in two affected workspaces;
an in-memory synthetic environment change produced a different hash. Ownership,
file membership and complete container-population checks remain mandatory.
Focused tests cover stdin transport, literal values, rendering failure and drift
rejection. A matching hash does not prove application readiness.
