# ADR 0004: Make the Traefik file authoritative for route state

Status: Accepted

Context: Devrouter previously wrote route metadata JSON and the rendered Traefik file independently, so interruption could leave readers and Traefik acting on different route generations.

Decision: Store versioned, encoded route metadata in the Traefik file header and replace that file atomically and durably. Keep validated JSON as a compatibility mirror written before the canonical file; migrate headerless legacy generations from JSON and repair stale mirrors from canonical metadata.

Why: One artifact lets readers identify the exact generation Traefik received, fail closed on corruption, and recover safely across interrupted or mixed-version writes.
