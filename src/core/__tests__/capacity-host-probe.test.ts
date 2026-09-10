import { expect, it, vi } from "vitest";
import { evaluateCapacity } from "../capacity-accounting";
import { collectDeclaredHostCapacity, readCapacityHostSnapshot } from "../capacity-host-probe";
import type { CapacityHostDomain } from "../capacity-policy";
import type { runControllerProbe } from "../controller-probe";

function probeFor(memory = "17179869184\n", pressure = "1\n") {
  return vi
    .fn<typeof runControllerProbe>()
    .mockImplementation(async (_command, args) => (args[1] === "hw.memsize" ? memory : pressure));
}

const declaredHost: CapacityHostDomain = {
  kind: "host",
  adapter: "macos-declared-v1",
  unmanagedAllowanceBytes: 20,
  capacityBytes: 100,
  protectedHeadroomBytes: 10,
  startupSlots: 1,
  heavySlots: 1,
};

it("adds declared host allowance, one shared pool and host-only reservations independently", async () => {
  const host = await collectDeclaredHostCapacity(declaredHost, new AbortController().signal, {
    platform: "darwin",
    probe: probeFor("100"),
  });
  expect(host).toMatchObject({ unmanagedBytes: 20, sharedBytes: 0, ownedBytes: {} });
  const budgets = { host: declaredHost, guest: { ...declaredHost, capacityBytes: 200 } };
  const samples = { host, guest: { ...host, unmanagedBytes: 0 } };
  const retained = [
    { environmentId: "first", totals: { host: 5, guest: 40 }, startup: false, heavy: false },
  ];
  const requested = {
    environmentId: "second",
    totals: { host: 5, guest: 50 },
    startup: false,
    heavy: false,
  };
  const pools = [{ hostDomain: "host", hostChargeCeilingBytes: 60 }];
  expect(
    evaluateCapacity(budgets, samples, retained, requested, host.sampledAtMs, 1000, pools),
  ).toEqual({ admitted: true });
  expect(
    evaluateCapacity(
      budgets,
      samples,
      retained,
      { ...requested, totals: { host: 6, guest: 50 } },
      host.sampledAtMs,
      1000,
      pools,
    ),
  ).toEqual({ admitted: false, domain: "host", reason: "memory" });
  expect(
    evaluateCapacity(
      budgets,
      samples,
      retained,
      { ...requested, totals: { host: 5, guest: 151 } },
      host.sampledAtMs,
      1000,
      pools,
    ),
  ).toEqual({ admitted: false, domain: "guest", reason: "memory" });
});

it("rejects legacy production mapping before probing and oversized declared capacity", async () => {
  const probe = probeFor("99");
  const { unmanagedAllowanceBytes: _allowance, ...legacy } = declaredHost;
  await expect(
    collectDeclaredHostCapacity(
      { ...legacy, adapter: "macos-host-v1" },
      new AbortController().signal,
      { platform: "darwin", probe },
    ),
  ).rejects.toThrow();
  expect(probe).not.toHaveBeenCalled();
  await expect(
    collectDeclaredHostCapacity(declaredHost, new AbortController().signal, {
      platform: "darwin",
      probe,
    }),
  ).rejects.toThrow();
});

it.each([
  ["2", "pressure"],
  ["8", "unknown"],
])("prevents declared admission on pressure flag %s", async (flag, reason) => {
  const host = await collectDeclaredHostCapacity(declaredHost, new AbortController().signal, {
    platform: "darwin",
    probe: probeFor("100", flag),
  });
  expect(
    evaluateCapacity(
      { host: declaredHost },
      { host },
      [],
      { environmentId: "test", totals: { host: 0 }, startup: false, heavy: false },
      host.sampledAtMs,
      1000,
    ),
  ).toEqual({ admitted: false, domain: "host", reason });
});

it("retains collection start time and rejects late or cancelled evidence", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1000);
    const probe = probeFor("100");
    probe.mockImplementation(async (_command, args) => {
      vi.setSystemTime(3000);
      return args[1] === "hw.memsize" ? "100" : "1";
    });
    const host = await collectDeclaredHostCapacity(declaredHost, new AbortController().signal, {
      platform: "darwin",
      probe,
    });
    expect(host.sampledAtMs).toBe(1000);
    const request = { environmentId: "test", totals: { host: 0 }, startup: false, heavy: false };
    for (const now of [0, 3000])
      expect(evaluateCapacity({ host: declaredHost }, { host }, [], request, now, 1000)).toEqual({
        admitted: false,
        domain: "host",
        reason: "stale",
      });
    const cancellation = new AbortController();
    probe.mockImplementation(async () => {
      cancellation.abort();
      return "100";
    });
    await expect(
      collectDeclaredHostCapacity(declaredHost, cancellation.signal, { platform: "darwin", probe }),
    ).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["1", "normal"],
  ["2", "pressured"],
  ["4", "pressured"],
  ["0", "unknown"],
  ["3", "unknown"],
  ["8", "unknown"],
])("maps dispatch pressure flag %s to %s", async (flag, pressure) => {
  const signal = new AbortController().signal;
  const probe = probeFor("17179869184\n", `${flag}\n`);
  await expect(readCapacityHostSnapshot(signal, { platform: "darwin", probe })).resolves.toEqual({
    physicalBytes: 17179869184,
    pressure,
  });
  expect(probe.mock.calls).toEqual([
    ["/usr/sbin/sysctl", ["-n", "hw.memsize"], expect.any(AbortSignal)],
    ["/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], expect.any(AbortSignal)],
  ]);
});

it.each([
  "0",
  "-1",
  "1.5",
  "1e6",
  "",
  "memory: 1024",
  "9007199254740992",
])("rejects malformed or unsafe physical memory (%s)", async (memory) => {
  await expect(
    readCapacityHostSnapshot(new AbortController().signal, {
      platform: "darwin",
      probe: probeFor(memory),
    }),
  ).rejects.toThrow(Error);
});

it.each([
  "",
  "-1",
  "1.5",
  "9007199254740992",
  "synthetic-private-output",
])("rejects malformed pressure counters (%s)", async (pressure) => {
  await expect(
    readCapacityHostSnapshot(new AbortController().signal, {
      platform: "darwin",
      probe: probeFor("1024", pressure),
    }),
  ).rejects.toThrow(Error);
});

it("refuses unsupported platforms before invoking probes", async () => {
  const probe = probeFor();
  await expect(
    readCapacityHostSnapshot(new AbortController().signal, { platform: "linux", probe }),
  ).rejects.toThrow(Error);
  expect(probe).not.toHaveBeenCalled();
});

it("refuses already aborted probes", async () => {
  const controller = new AbortController();
  controller.abort();
  const probe = probeFor();
  await expect(
    readCapacityHostSnapshot(controller.signal, { platform: "darwin", probe }),
  ).rejects.toThrow(Error);
  expect(probe).not.toHaveBeenCalled();
});

it("rejects evidence arriving after cancellation", async () => {
  const controller = new AbortController();
  const probe = probeFor();
  probe.mockImplementation(async () => {
    controller.abort();
    return "1";
  });
  await expect(
    readCapacityHostSnapshot(controller.signal, { platform: "darwin", probe }),
  ).rejects.toThrow(Error);
});

it("omits underlying probe errors and output", async () => {
  const probe = probeFor();
  probe.mockRejectedValue(new Error("synthetic-private-output"));
  const result = readCapacityHostSnapshot(new AbortController().signal, {
    platform: "darwin",
    probe,
  });
  await expect(result).rejects.toThrow(Error);
  const error = await result.catch((rejection: Error) => rejection);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("synthetic-private-output");
});

it("aborts and drains the sibling before reporting a failed snapshot", async () => {
  let siblingDrained = false;
  const probe = vi.fn<typeof runControllerProbe>().mockImplementation((_command, args, signal) => {
    if (args[1] === "hw.memsize") return Promise.reject(new Error("synthetic failure"));
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          queueMicrotask(() => {
            siblingDrained = true;
            reject(new Error("synthetic cancellation"));
          });
        },
        { once: true },
      );
    });
  });
  await expect(
    readCapacityHostSnapshot(new AbortController().signal, { platform: "darwin", probe }),
  ).rejects.toThrow(Error);
  expect(siblingDrained).toBe(true);
});
