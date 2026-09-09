import { expect, it, vi } from "vitest";
import { collectCapacityDomains } from "../capacity-collector";
import type { CapacityPolicy } from "../capacity-policy";

it.each([
  false,
  true,
])("publishes runtime samples only after ownership revalidation (drift=%s)", async (drift) => {
  const policy = {
    domains: { host: { kind: "host" }, guest: { kind: "runtime" } },
  } as unknown as CapacityPolicy;
  const events: string[] = [];
  const sample = {
    sampledAtMs: 1,
    pressure: "normal" as const,
    unmanagedBytes: 10,
    sharedBytes: 0,
    ownedBytes: {},
  };
  const revalidate = vi.fn(async () => {
    events.push("revalidate");
    if (drift) throw new Error("changed");
  });
  const dependencies = {
    ownership: vi.fn(async () => {
      events.push("resolve");
      return { proveOwned: async () => [], revalidate };
    }),
    host: vi.fn(async () => sample),
    runtime: vi.fn(async () => {
      events.push("sample");
      return sample;
    }),
  };
  const result = await collectCapacityDomains(policy, new AbortController().signal, dependencies);
  expect(events).toEqual(["resolve", "sample", "revalidate"]);
  expect(result.host).toEqual(sample);
  expect(result.guest.pressure).toBe(drift ? "unknown" : "normal");
});
it("rejects cancellation rather than publishing partial domains", async () => {
  const cancellation = new AbortController();
  const policy = {
    domains: { host: { kind: "host" }, guest: { kind: "runtime" } },
  } as unknown as CapacityPolicy;
  const ownership = vi.fn();
  const dependencies = {
    ownership,
    runtime: vi.fn(),
    host: vi.fn(async () => {
      cancellation.abort();
      throw new Error("aborted");
    }),
  };
  await expect(collectCapacityDomains(policy, cancellation.signal, dependencies)).rejects.toThrow();
  expect(ownership).not.toHaveBeenCalled();
});
