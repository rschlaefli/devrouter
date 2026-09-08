import { expect, it } from "vitest";
import {
  type CapacityCharge,
  type CapacityDomainSample,
  evaluateCapacity,
} from "../capacity-accounting";

const budget = { capacityBytes: 100, protectedHeadroomBytes: 10, startupSlots: 1, heavySlots: 1 };
const sample = {
  sampledAtMs: 1000,
  pressure: "normal" as const,
  unmanagedBytes: 10,
  sharedBytes: 10,
  ownedBytes: {},
};
const request: CapacityCharge = {
  environmentId: "one",
  totals: { guest: 50 },
  startup: true,
  heavy: false,
};

it("charges startup total once while retaining observed and previously reserved excess", () => {
  const steady = { ...request, totals: { guest: 30 }, startup: false };
  expect(
    evaluateCapacity({ guest: budget }, { guest: sample }, [steady], request, 1000, 15_000),
  ).toEqual({ admitted: true });
  const populations: Record<string, number>[] = [{ one: 71 }, { other: 21 }];
  for (const ownedBytes of populations) {
    expect(
      evaluateCapacity(
        { guest: budget },
        { guest: { ...sample, ownedBytes } },
        [steady],
        request,
        1000,
        15_000,
      ),
    ).toEqual({ admitted: false, domain: "guest", reason: "memory" });
  }
  expect(
    evaluateCapacity(
      { guest: budget },
      { guest: sample },
      [{ ...steady, totals: { guest: 71 } }],
      request,
      1000,
      15_000,
    ),
  ).toEqual({ admitted: false, domain: "guest", reason: "memory" });
});

it("rejects the whole request if any domain lacks fresh, normal evidence", () => {
  const multi = { ...request, totals: { host: 20, guest: 50 } };
  const budgets = { host: budget, guest: budget };
  for (const guest of [
    undefined,
    { ...sample, pressure: "unknown" as const },
    { ...sample, sampledAtMs: 0 },
  ]) {
    const samples: Record<string, CapacityDomainSample> = { host: sample };
    if (guest) samples.guest = guest;
    const before = JSON.stringify(samples);
    expect(evaluateCapacity(budgets, samples, [], multi, 16_001, 15_000).admitted).toBe(false);
    expect(JSON.stringify(samples)).toBe(before);
  }
  expect(
    evaluateCapacity(budgets, { host: sample, guest: sample }, [], multi, 1000, 15_000),
  ).toEqual({ admitted: true });
});

it("retains occupied startup and heavy slots independently of observed bytes", () => {
  for (const phase of ["startup", "heavy"] as const) {
    const occupied = {
      environmentId: "two",
      totals: { guest: 0 },
      startup: false,
      heavy: false,
      [phase]: true,
    };
    const pending = { ...request, startup: false, heavy: false, [phase]: true };
    expect(
      evaluateCapacity({ guest: budget }, { guest: sample }, [occupied], pending, 1000, 15_000),
    ).toEqual({
      admitted: false,
      domain: "guest",
      reason: phase === "startup" ? "startup-slot" : "heavy-slot",
    });
  }
});

it("does not round overflowing sums into admissible budgets", () => {
  const huge = { ...budget, capacityBytes: Number.MAX_SAFE_INTEGER, protectedHeadroomBytes: 1 };
  expect(
    evaluateCapacity(
      { guest: huge },
      { guest: { ...sample, unmanagedBytes: Number.MAX_SAFE_INTEGER } },
      [],
      request,
      1000,
      15_000,
    ),
  ).toEqual({ admitted: false, domain: "guest", reason: "memory" });
});

it("charges pool ceilings only to their hosts and independently from environment slots", () => {
  const pools = [
    { hostDomain: "host", hostChargeCeilingBytes: 60 },
    { hostDomain: "other-host", hostChargeCeilingBytes: 90 },
  ];
  const pending = { ...request, totals: { host: 30 } };
  expect(
    evaluateCapacity(
      { host: budget },
      { host: { ...sample, unmanagedBytes: 0, sharedBytes: 0 } },
      [],
      pending,
      1000,
      15_000,
      pools,
    ),
  ).toEqual({ admitted: true });
  expect(
    evaluateCapacity(
      { host: budget },
      { host: { ...sample, unmanagedBytes: 0, sharedBytes: 0 } },
      [],
      { ...pending, totals: { host: 31 } },
      1000,
      15_000,
      pools,
    ),
  ).toEqual({ admitted: false, domain: "host", reason: "memory" });
});

it("sums durable pool ceilings without rounding at the safe integer boundary", () => {
  const huge = { ...budget, capacityBytes: Number.MAX_SAFE_INTEGER, protectedHeadroomBytes: 0 };
  const pools = [
    { hostDomain: "host", hostChargeCeilingBytes: Number.MAX_SAFE_INTEGER - 1 },
    { hostDomain: "host", hostChargeCeilingBytes: 1 },
  ];
  const samples = { host: { ...sample, unmanagedBytes: 0, sharedBytes: 0 } };
  expect(
    evaluateCapacity(
      { host: huge },
      samples,
      [],
      { ...request, totals: { host: 0 } },
      1000,
      15_000,
      pools,
    ),
  ).toEqual({ admitted: true });
  expect(
    evaluateCapacity(
      { host: huge },
      samples,
      [],
      { ...request, totals: { host: 1 } },
      1000,
      15_000,
      pools,
    ),
  ).toEqual({ admitted: false, domain: "host", reason: "memory" });
});
