# Architecture decision records

These records capture durable Devrouter trade-offs. Current operating
procedures belong in the [documentation map](../README.md) and the knowledge
bundle; this index only lists the accepted decisions.

- [ADR 0001: Persist managed-workspace ownership in the consumer Git common directory](./0001-repo-local-workspace-ownership.md)
- [ADR 0002: Keep devrouter out of consumer images](./0002-keep-devrouter-out-of-consumer-images.md)
- [ADR 0003: Serialize DevPod provider mutations machine-wide](./0003-serialize-devpod-provider-mutations.md)
- [ADR 0004: Make the Traefik file authoritative for route state](./0004-single-artifact-route-state.md)
- [ADR 0005: Keep devcontainer profile dimensions independent](./0005-dependency-aware-devcontainer-profiles.md)
- [ADR 0006: Verify Devsy agents in Devrouter-owned state](./0006-devrouter-owned-devsy-agent-acquisition.md)
- [ADR 0007: Keep CI profile planning repository-owned](./0007-keep-ci-profile-planning-repository-owned.md)
