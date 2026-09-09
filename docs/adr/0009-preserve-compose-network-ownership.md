# ADR 0009: Preserve Compose network ownership while reserving workspace subnets

Status: accepted design; implementation in progress.

New managed linked-workspace networks may use explicit subnets from an opt-in,
operator-owned policy bound to the Docker daemon. Compose continues to create
and own the networks. Devrouter reserves subnets before provider dispatch under
a short shared allocation lock, and retains fenced claims when the provider
outcome is uncertain. This avoids changing daemon-wide pools or adopting existing
networks while preventing cooperating Devsy and DevPod starts from choosing the
same subnet.

Claims reuse lifecycle operation identity and workspace ownership; they do not
create another job controller or a global repository registry. The provider
ownership lock precedes the allocation lock, and memory admission completes
before both. Provider dispatch and route publication require qualified daemon
and route evidence. Existing networks retain their subnet on stop and resume;
removing a policy never silently resizes or replaces them.

Pre-created external networks would change lifecycle ownership and add an earlier
Docker effect. Daemon-wide pool changes would affect unrelated work. Those
alternatives remain outside this source package, as do automatic cleanup and
migration. A smaller default applies only to new eligible allocations and cannot
recover occupied address space from existing larger networks.
