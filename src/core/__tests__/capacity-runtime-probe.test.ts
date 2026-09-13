import { expect, it, vi } from "vitest";
import type { CapacityRuntimeDomain } from "../capacity-policy";
import {
  type CapacityOwnedPopulation,
  collectDeclaredRuntimeCapacity,
} from "../capacity-runtime-probe";

const domain: CapacityRuntimeDomain = {
  kind: "runtime",
  adapter: "orbstack-declared-v1",
  endpoint: "/tmp/synthetic.sock",
  daemonId: "synthetic",
  hostDomain: "host",
  hostChargeCeilingBytes: 1000,
  capacityBytes: 1000,
  protectedHeadroomBytes: 100,
  startupSlots: 1,
  heavySlots: 1,
  guestUnmanagedAllowanceBytes: 50,
};
const environmentId = "a".repeat(64);
function population(): CapacityOwnedPopulation[] {
  return [
    {
      environmentId,
      containers: [true, false].map((running, index) => ({
        id: String(index).repeat(64),
        labels: {},
        mounts: [],
        networks: {},
        state: {
          Status: running ? "running" : "exited",
          Running: running,
          Paused: false,
          Restarting: false,
          Dead: false,
        },
      })),
    },
  ];
}
function fixture() {
  const prove = vi.fn(async () => population());
  const info = vi.fn(async () => ({ ID: "synthetic", MemTotal: 1000 }));
  const memory = vi.fn(async () => ({ usage: 120, limit: 900 }));
  const host = vi.fn(async () => ({
    physicalBytes: 2000,
    pressure: "normal" as "normal" | "pressured" | "unknown",
  }));
  const cancellation = new AbortController();
  return {
    prove,
    info,
    memory,
    host,
    cancellation,
    run: () =>
      collectDeclaredRuntimeCapacity(domain, prove, cancellation.signal, { info, memory, host }),
  };
}
it("accounts raw running usage and explicit allowance with collection-start freshness", async () => {
  const f = fixture();
  const before = Date.now();
  const result = await f.run();
  expect(result).toMatchObject({
    pressure: "normal",
    unmanagedBytes: 50,
    sharedBytes: 0,
    ownedBytes: { [environmentId]: 120 },
  });
  expect(result.sampledAtMs).toBeGreaterThanOrEqual(before);
  expect(result.sampledAtMs).toBeLessThanOrEqual(Date.now());
  expect(f.memory).toHaveBeenCalledTimes(1);
  expect(f.prove).toHaveBeenCalledTimes(2);
  expect(f.info).toHaveBeenCalledTimes(2);
});
it.each([
  "pressured",
  "unknown",
] as const)("preserves %s host pressure without fabricating guest evidence", async (pressure) => {
  const f = fixture();
  f.host.mockResolvedValue({ physicalBytes: 2000, pressure });
  expect((await f.run()).pressure).toBe(pressure);
});
it("rejects legacy before probes", async () => {
  const f = fixture();
  await expect(
    collectDeclaredRuntimeCapacity(
      { ...domain, adapter: "orbstack-local-v1" },
      f.prove,
      f.cancellation.signal,
      { info: f.info },
    ),
  ).rejects.toThrow();
  expect(f.info).not.toHaveBeenCalled();
  expect(f.prove).not.toHaveBeenCalled();
});
it.each([
  "daemon",
  "bound",
  "population",
  "duplicate",
  "state",
  "usage",
  "overflow",
  "ownership",
  "cancel",
])("rejects %s evidence", async (mode) => {
  const f = fixture();
  if (mode === "daemon")
    f.info
      .mockResolvedValueOnce({ ID: "synthetic", MemTotal: 1000 })
      .mockResolvedValue({ ID: "other", MemTotal: 1000 });
  if (mode === "bound") f.info.mockResolvedValue({ ID: "synthetic", MemTotal: 999 });
  if (mode === "population")
    f.prove.mockImplementationOnce(async () => population()).mockImplementation(async () => []);
  if (mode === "duplicate")
    f.prove.mockImplementation(async () => [...population(), ...population()]);
  if (mode === "state")
    f.prove.mockImplementation(async () => {
      const p = population();
      p[0].containers[0].state.Running = false;
      return p;
    });
  if (mode === "usage") f.memory.mockResolvedValue({ usage: -1, limit: 900 });
  if (mode === "overflow") {
    f.prove.mockImplementation(async () => {
      const p = population();
      p[0].containers[1].state = { ...p[0].containers[0].state };
      return p;
    });
    f.memory.mockResolvedValue({ usage: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER });
  }
  if (mode === "ownership") f.prove.mockRejectedValue(new Error("unproven"));
  if (mode === "cancel") f.cancellation.abort();
  await expect(f.run()).rejects.toThrow();
});
it("aborts and drains sibling memory probes on failure", async () => {
  const f = fixture();
  f.prove.mockImplementation(async () => {
    const p = population();
    p[0].containers[1].state = { ...p[0].containers[0].state };
    return p;
  });
  let drained = false;
  const memory = vi.fn(async (_endpoint: string, id: string, signal: AbortSignal) => {
    if (id.startsWith("0")) {
      await Promise.resolve();
      throw new Error("failure");
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          drained = true;
          resolve();
        },
        { once: true },
      );
    });
    throw new Error("cancelled");
  });
  await expect(
    collectDeclaredRuntimeCapacity(domain, f.prove, f.cancellation.signal, {
      info: f.info,
      host: f.host,
      memory,
    }),
  ).rejects.toThrow();
  expect(drained).toBe(true);
});
