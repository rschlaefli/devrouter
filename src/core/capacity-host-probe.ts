import { runControllerProbe } from "./controller-probe";

export type CapacityHostSnapshot = {
  physicalBytes: number;
  pressure: "normal" | "pressured" | "unknown";
};

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
    const [memory, level] = await Promise.all([
      probe("/usr/sbin/sysctl", ["-n", "hw.memsize"], signal),
      probe("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], signal),
    ]);
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
