import { isDeepStrictEqual } from "node:util";
import type { CapacityDomainSample } from "./capacity-accounting";
import { readDockerCapacityInfo, readDockerCapacityMemory } from "./capacity-docker-probe";
import { readCapacityHostSnapshot } from "./capacity-host-probe";
import type { CapacityRuntimeDomain } from "./capacity-policy";
import type { ManagedStopContainerSnapshot } from "./devpod-environment";

export type CapacityOwnedPopulation = {
  environmentId: string;
  containers: ManagedStopContainerSnapshot[];
};

/** The caller proves every enrolled workspace and its complete population on each invocation. */
export async function collectDeclaredRuntimeCapacity(
  domain: CapacityRuntimeDomain,
  proveOwned: (signal: AbortSignal) => Promise<CapacityOwnedPopulation[]>,
  signal: AbortSignal,
  dependencies: {
    info?: typeof readDockerCapacityInfo;
    memory?: typeof readDockerCapacityMemory;
    host?: typeof readCapacityHostSnapshot;
  } = {},
): Promise<CapacityDomainSample> {
  if (domain.adapter !== "orbstack-declared-v1")
    throw new Error("Production runtime admission requires an explicit declared-budget policy.");
  const sampledAtMs = Date.now();
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  const timer = setTimeout(() => cancellation.abort(), 3000);
  const deadline = performance.now() + 3000;
  const check = () => {
    if (combined.aborted || performance.now() >= deadline)
      throw new Error("Runtime capacity collection expired.");
  };
  const info = dependencies.info ?? readDockerCapacityInfo;
  const memory = dependencies.memory ?? readDockerCapacityMemory;
  const host = dependencies.host ?? readCapacityHostSnapshot;
  const readInfo = async () => {
    check();
    const value = await info(domain.endpoint, combined);
    check();
    if (value.ID !== domain.daemonId || domain.capacityBytes > value.MemTotal)
      throw new Error("Runtime capacity identity or physical bound changed.");
    return value;
  };
  const readOwned = async () => {
    check();
    const values = structuredClone(await proveOwned(combined));
    check();
    if (values.length > 256) throw new Error("Runtime ownership population exceeds bound.");
    const environments = new Set<string>();
    const ids = new Set<string>();
    for (const value of values) {
      if (!/^[a-f0-9]{64}$/.test(value.environmentId) || environments.has(value.environmentId))
        throw new Error("Runtime ownership identity is ambiguous.");
      environments.add(value.environmentId);
      for (const container of value.containers) {
        if (!/^[a-f0-9]{64}$/.test(container.id) || ids.has(container.id) || ids.size >= 256)
          throw new Error("Runtime container attribution is ambiguous or exceeds bound.");
        ids.add(container.id);
        const state = container.state;
        if (
          state.Paused ||
          state.Restarting ||
          state.Dead ||
          !["running", "exited", "created"].includes(state.Status) ||
          state.Running !== (state.Status === "running")
        )
          throw new Error("Runtime container state is uncertain.");
        container.mounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      value.containers.sort((a, b) => a.id.localeCompare(b.id));
    }
    return values.sort((a, b) => a.environmentId.localeCompare(b.environmentId));
  };
  try {
    check();
    // This is host pressure, not evidence of guest pressure or guest OOM protection.
    const pressure = (await host(combined)).pressure;
    check();
    const beforeInfo = await readInfo();
    const before = await readOwned();
    const ownedBytes: Record<string, number> = Object.fromEntries(
      before.map((value) => [value.environmentId, 0]),
    );
    const running = before.flatMap((value) =>
      value.containers
        .filter((container) => container.state.Running)
        .map((container) => ({ environmentId: value.environmentId, id: container.id })),
    );
    let next = 0;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(4, running.length) }, async () => {
        try {
          while (next < running.length) {
            check();
            const value = running[next++];
            const observed = await memory(domain.endpoint, value.id, combined);
            check();
            if (!Number.isSafeInteger(observed.usage) || observed.usage < 0)
              throw new Error("Runtime memory usage is invalid.");
            const total = ownedBytes[value.environmentId] + observed.usage;
            if (!Number.isSafeInteger(total)) throw new Error("Runtime memory sum is unsafe.");
            ownedBytes[value.environmentId] = total;
          }
        } catch (error) {
          cancellation.abort();
          throw error;
        }
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Runtime memory collection failed.");
    check();
    if (
      !isDeepStrictEqual(before, await readOwned()) ||
      !isDeepStrictEqual(beforeInfo, await readInfo())
    )
      throw new Error("Runtime population or daemon changed during memory collection.");
    check();
    return {
      sampledAtMs,
      pressure,
      unmanagedBytes: domain.guestUnmanagedAllowanceBytes,
      sharedBytes: 0,
      ownedBytes,
    };
  } catch {
    cancellation.abort();
    throw new Error("Runtime capacity probe failed.");
  } finally {
    clearTimeout(timer);
  }
}
