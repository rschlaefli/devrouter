# ADR 0002: Keep devrouter out of consumer images

Status: Accepted

Devrouter owns generic development-process reconciliation, but consumer images own only application runtime dependencies. `devrouter ensure` therefore supplies its matching process helper to a running managed devcontainer and invokes the repository-owned post-start adapter; generated Dockerfiles never download, install, or version-pin devrouter artifacts.
