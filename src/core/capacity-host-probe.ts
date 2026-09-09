import type { CapacityDomainSample } from "./capacity-accounting";
import type { CapacityHostDomain } from "./capacity-policy";
import { runControllerProbe } from "./controller-probe";

export type CapacityHostSnapshot = {
  physicalBytes: number;
  pressure: "normal" | "pressured" | "unknown";
};

/** Pool budgets and host-only reservations are added separately by admission. */
export async function collectDeclaredHostCapacity(
  domain: CapacityHostDomain,
  signal: AbortSignal,
  dependencies: Parameters<typeof readCapacityHostSnapshot>[1] = {},
): Promise<CapacityDomainSample> {
  if (domain.adapter !== "macos-declared-v1")
    throw new Error("Production host admission requires an explicit declared-budget policy.");
  // Use the beginning of collection so delayed evidence never gains a fresh lease.
  const sampledAtMs = Date.now();
  const snapshot = await readCapacityHostSnapshot(signal, dependencies);
  if (domain.capacityBytes > snapshot.physicalBytes)
    throw new Error("Declared host capacity exceeds physical memory.");
  return {
    sampledAtMs,
    pressure: snapshot.pressure,
    unmanagedBytes: domain.unmanagedAllowanceBytes,
    sharedBytes: 0,
    ownedBytes: {},
  };
}

function counter(output: string): number {
  const text = output.trim();
  if (!/^[0-9]{1,16}$/.test(text)) throw new Error("Invalid host counter.");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid host counter.");
  return value;
}

/** Internal dependencies support synthetic tests; commands are fixed, never caller-configured. */
export async function readCapacityHostSnapshot(
  signal: AbortSignal,
  dependencies: { probe?: typeof runControllerProbe; platform?: NodeJS.Platform } = {},
): Promise<CapacityHostSnapshot> {
  try {
    if ((dependencies.platform ?? process.platform) !== "darwin" || signal.aborted)
      throw new Error("Host probe unavailable.");
    const probe = dependencies.probe ?? runControllerProbe;
    const cancellation = new AbortController();
    const probeSignal = AbortSignal.any([signal, cancellation.signal]);
    const results = await Promise.allSettled(
      ["hw.memsize", "kern.memorystatus_vm_pressure_level"].map((name) =>
        Promise.resolve()
          .then(() => probe("/usr/sbin/sysctl", ["-n", name], probeSignal))
          .catch((error: unknown) => {
            cancellation.abort();
            throw error;
          }),
      ),
    );
    const [memoryResult, levelResult] = results;
    if (memoryResult.status !== "fulfilled" || levelResult.status !== "fulfilled")
      throw new Error("Host probe unavailable.");
    const memory = memoryResult.value;
    const level = levelResult.value;
    if (signal.aborted) throw new Error("Host probe cancelled.");
    const physicalBytes = counter(memory);
    if (physicalBytes === 0) throw new Error("Invalid physical memory.");
    const flags = counter(level);
    // XNU kern_memorystatus_notify.c converts the sysctl pressure level to DISPATCH flags.
    const pressure = flags === 1 ? "normal" : flags === 2 || flags === 4 ? "pressured" : "unknown";
    return { physicalBytes, pressure };
  } catch {
    throw new Error("Host capacity probe failed.");
  }
}
