import { expect, it, vi } from "vitest";
import { readCapacityHostSnapshot } from "../capacity-host-probe";
import type { runControllerProbe } from "../controller-probe";

function probeFor(memory = "17179869184\n", pressure = "1\n") {
  return vi
    .fn<typeof runControllerProbe>()
    .mockImplementation(async (_command, args) => (args[1] === "hw.memsize" ? memory : pressure));
}

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
