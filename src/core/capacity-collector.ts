import type { CapacityDomainSample } from "./capacity-accounting";
import { collectDeclaredHostCapacity } from "./capacity-host-probe";
import { resolveCapacityOwnership } from "./capacity-ownership-resolver";
import type { CapacityPolicy } from "./capacity-policy";
import { collectDeclaredRuntimeCapacity } from "./capacity-runtime-probe";

/** Resolve and revalidate ownership around each memory sample, without changing machine policy. */
export async function collectCapacityDomains(
  policy: CapacityPolicy,
  signal: AbortSignal,
  dependencies = {
    ownership: resolveCapacityOwnership,
    host: collectDeclaredHostCapacity,
    runtime: collectDeclaredRuntimeCapacity,
  },
): Promise<Record<string, CapacityDomainSample>> {
  const result: Record<string, CapacityDomainSample> = {};
  for (const [id, domain] of Object.entries(policy.domains)) {
    if (signal.aborted) throw new Error("Capacity collection was cancelled.");
    const startedAtMs = Date.now();
    const cancellation = new AbortController();
    const domainSignal = AbortSignal.any([signal, cancellation.signal]);
    const timer = setTimeout(() => cancellation.abort(), 10_000);
    try {
      if (domain.kind === "host") {
        result[id] = await dependencies.host(domain, domainSignal);
      } else {
        const ownership = await dependencies.ownership(policy, id, domainSignal);
        const sample = await dependencies.runtime(domain, ownership.proveOwned, domainSignal);
        await ownership.revalidate();
        result[id] = { ...sample, sampledAtMs: Math.min(startedAtMs, sample.sampledAtMs) };
      }
      if (domainSignal.aborted) throw new Error("Capacity domain collection expired.");
    } catch {
      // Unknown evidence cannot admit work; other independently observed domains remain useful.
      result[id] = {
        sampledAtMs: Date.now(),
        pressure: "unknown",
        unmanagedBytes: 0,
        sharedBytes: 0,
        ownedBytes: {},
      };
    } finally {
      clearTimeout(timer);
    }
  }
  if (signal.aborted) throw new Error("Capacity collection was cancelled.");
  return result;
}
