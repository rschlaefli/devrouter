import { isDeepStrictEqual } from "node:util";
import {
  inspectDockerCapacityContainer,
  listDockerCapacityContainers,
  readDockerCapacityInfo,
} from "./capacity-docker-probe";
import type { ManagedStopContainerSnapshot } from "./devpod-environment";

/** Raw stable population evidence; callers must independently prove workspace ownership. */
export async function readDockerCapacityPopulation(
  endpoint: string,
  expectedDaemonId: string,
  composeProject: string,
  signal: AbortSignal,
): Promise<ManagedStopContainerSnapshot[]> {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 3000);
  const deadline = performance.now() + 3000;
  const check = () => {
    if (signal.aborted || cancellation.signal.aborted || performance.now() >= deadline)
      throw new Error("Population unavailable.");
  };
  try {
    check();
    if (
      typeof composeProject !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(composeProject)
    )
      throw new Error("Invalid project identity.");
    if (typeof expectedDaemonId !== "string" || !/^[a-zA-Z0-9:_-]{1,256}$/.test(expectedDaemonId))
      throw new Error("Invalid daemon identity.");
    const beforeInfo = await readDockerCapacityInfo(endpoint, cancellation.signal);
    if (beforeInfo.ID !== expectedDaemonId) throw new Error("Daemon changed.");
    const before = (
      await listDockerCapacityContainers(endpoint, cancellation.signal, composeProject)
    ).sort((a, b) => a.id.localeCompare(b.id));
    const snapshots: ManagedStopContainerSnapshot[] = new Array(before.length);
    let next = 0;
    let bytes = 2;
    const inspect = async () => {
      try {
        while (next < before.length) {
          check();
          const index = next++;
          const entry = before[index];
          const snapshot = await inspectDockerCapacityContainer(
            endpoint,
            entry.id,
            composeProject,
            cancellation.signal,
          );
          check();
          if (snapshot.state.Status !== entry.state) throw new Error("Population changed.");
          bytes += Buffer.byteLength(JSON.stringify(snapshot)) + (index === 0 ? 0 : 1);
          if (bytes > 1_048_576) throw new Error("Population exceeds bound.");
          snapshots[index] = snapshot;
        }
      } catch (error) {
        abort();
        throw error;
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(4, before.length) }, inspect));
    check();
    const after = (
      await listDockerCapacityContainers(endpoint, cancellation.signal, composeProject)
    ).sort((a, b) => a.id.localeCompare(b.id));
    if (!isDeepStrictEqual(before, after)) throw new Error("Population changed.");
    const afterInfo = await readDockerCapacityInfo(endpoint, cancellation.signal);
    check();
    if (afterInfo.ID !== expectedDaemonId) throw new Error("Daemon changed.");
    return snapshots;
  } catch {
    abort();
    throw new Error("Docker capacity population unavailable.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
