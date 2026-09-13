import { expect, it } from "vitest";
import {
  type CapacityCharge,
  type CapacityDomainSample,
  type CapacityEvidenceClock,
  CapacityPressureTracker,
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

const tracked = (domainIds: string[] = ["host", "guest"], maxSampleAgeMs = 15_000) =>
  new CapacityPressureTracker(domainIds, maxSampleAgeMs);

const sampleAt = (
  sampledAtMs: number,
  pressure: CapacityDomainSample["pressure"] = "normal",
  ownedBytes: Record<string, number> = {},
): CapacityDomainSample => ({
  sampledAtMs,
  pressure,
  unmanagedBytes: 1,
  sharedBytes: 1,
  ownedBytes,
});

const clock = (wallMs: number, monotonicMs: number = wallMs): CapacityEvidenceClock => ({
  wallMs,
  monotonicMs,
});

const unknownEvidence = { pressure: "unknown", observedDurationMs: 0, sampledAtMs: null };

it("declares at least one nonempty unique domain within the policy bound", () => {
  expect(() => new CapacityPressureTracker([], 15_000)).toThrow();
  expect(() => new CapacityPressureTracker([""], 15_000)).toThrow();
  expect(() => new CapacityPressureTracker(["host", "host"], 15_000)).toThrow();
  expect(() => new CapacityPressureTracker(["host"], 0)).toThrow();
  expect(() => new CapacityPressureTracker(["host"], 1.5)).toThrow();
  expect(() => new CapacityPressureTracker(["host"], Number.MAX_SAFE_INTEGER + 1)).toThrow();
  expect(
    () =>
      new CapacityPressureTracker(
        Array.from({ length: 257 }, (_, index) => `domain-${index}`),
        15_000,
      ),
  ).toThrow();
  expect(
    () =>
      new CapacityPressureTracker(
        Array.from({ length: 256 }, (_, index) => `domain-${index}`),
        15_000,
      ),
  ).not.toThrow();
  expect(new CapacityPressureTracker(["host"], 15_000).read(["host"], clock(1000))).toEqual({
    host: unknownEvidence,
  });
});

it("accrues dwell only across continuous same-pressure samples", () => {
  const tracker = tracked();
  tracker.observe({ host: sampleAt(1000), guest: sampleAt(1000, "pressured") }, clock(1000));
  tracker.observe({ host: sampleAt(5000), guest: sampleAt(5000, "pressured") }, clock(5000));
  expect(tracker.read(["host", "guest"], clock(5000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 4000, sampledAtMs: 5000 },
    guest: { pressure: "pressured", observedDurationMs: 4000, sampledAtMs: 5000 },
  });
  tracker.observe({ host: sampleAt(9000, "pressured"), guest: sampleAt(9000) }, clock(9000));
  expect(tracker.read(["host", "guest"], clock(9000))).toEqual({
    host: { pressure: "pressured", observedDurationMs: 0, sampledAtMs: 9000 },
    guest: { pressure: "normal", observedDurationMs: 0, sampledAtMs: 9000 },
  });
});

it("restarts a window at zero once the predecessor sample is no longer valid", () => {
  const tracker = tracked(["host"], 5000);
  tracker.observe({ host: sampleAt(1000) }, clock(1000));
  tracker.observe({ host: sampleAt(7001) }, clock(7001));
  expect(tracker.read(["host"], clock(7001))).toEqual({
    host: { pressure: "normal", observedDurationMs: 0, sampledAtMs: 7001 },
  });
});

it("never extends duration on read and expires the window at the wall-age boundary", () => {
  const tracker = tracked(["host"], 5000);
  tracker.observe({ host: sampleAt(1000) }, clock(1000));
  tracker.observe({ host: sampleAt(4000) }, clock(4000));
  const live = { host: { pressure: "normal", observedDurationMs: 3000, sampledAtMs: 4000 } };
  expect(tracker.read(["host"], clock(9000))).toEqual(live);
  expect(tracker.read(["host"], clock(9000))).toEqual(live);
  expect(tracker.read(["host"], clock(9001))).toEqual({ host: unknownEvidence });
});

it("omits malformed, stale and future samples while accepting the age boundary", () => {
  const boundary = tracked(["host"], 5000);
  expect(boundary.observe({ host: sampleAt(1000) }, clock(6000))).toEqual({
    host: sampleAt(1000),
  });
  expect(boundary.read(["host"], clock(6000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 0, sampledAtMs: 1000 },
  });
  expect(boundary.observe({ host: sampleAt(1000) }, clock(6001))).toEqual({});
  expect(boundary.read(["host"], clock(6001))).toEqual({ host: unknownEvidence });

  const future = tracked(["host"]);
  expect(future.observe({ host: sampleAt(2001) }, clock(2000))).toEqual({});
  expect(future.read(["host"], clock(2000))).toEqual({ host: unknownEvidence });

  const malformed = tracked(["host"]);
  const invalid: unknown[] = [
    undefined,
    { ...sampleAt(1000), sampledAtMs: -1 },
    { ...sampleAt(1000), sampledAtMs: 1.5 },
    { ...sampleAt(1000), pressure: "heavy" },
    { ...sampleAt(1000), unmanagedBytes: -1 },
    { ...sampleAt(1000), sharedBytes: 1.5 },
    { ...sampleAt(1000), ownedBytes: null },
    { ...sampleAt(1000), ownedBytes: { guest: -1 } },
  ];
  for (const sample of invalid) {
    expect(malformed.observe({ host: sample as CapacityDomainSample }, clock(1000))).toEqual({});
  }
  expect(malformed.read(["host"], clock(1000))).toEqual({ host: unknownEvidence });
});

it("never rebuilds a window from an equal timestamp and ends it on a contradiction", () => {
  const tracker = tracked(["host"]);
  tracker.observe({ host: sampleAt(1000) }, clock(1000));
  tracker.observe({ host: sampleAt(4000) }, clock(4000));
  expect(tracker.observe({ host: sampleAt(4000) }, clock(5000))).toEqual({ host: sampleAt(4000) });
  expect(tracker.read(["host"], clock(5000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 3000, sampledAtMs: 4000 },
  });
  // any changed field at the accepted timestamp contradicts the evidence, so it ends
  // the window and never comes back as an admission sample
  expect(tracker.observe({ host: sampleAt(4000, "pressured") }, clock(6000))).toEqual({});
  expect(tracker.read(["host"], clock(6000))).toEqual({ host: unknownEvidence });
  for (const changed of [
    sampleAt(4000, "normal", { one: 10 }),
    { ...sampleAt(4000), unmanagedBytes: 3 },
    { ...sampleAt(4000), sharedBytes: 3 },
  ]) {
    expect(tracker.observe({ host: changed }, clock(7000))).toEqual({});
  }
  expect(tracker.read(["host"], clock(7000))).toEqual({ host: unknownEvidence });
  // the accepted evidence still repeats identically and still cannot rebuild a window
  expect(tracker.observe({ host: sampleAt(4000) }, clock(7000))).toEqual({ host: sampleAt(4000) });
  expect(tracker.read(["host"], clock(7000))).toEqual({ host: unknownEvidence });
});

it("never lets a contradictory equal timestamp replace accepted evidence", () => {
  const tracker = tracked(["host"]);
  const accepted = sampleAt(4000, "normal", { one: 10 });
  tracker.observe({ host: accepted }, clock(4000));
  // a lower byte charge at the same timestamp cannot replace the accepted evidence
  expect(tracker.observe({ host: sampleAt(4000, "normal", { one: 5 }) }, clock(5000))).toEqual({});
  expect(tracker.read(["host"], clock(5000))).toEqual({ host: unknownEvidence });
  expect(tracker.observe({ host: accepted }, clock(6000))).toEqual({ host: accepted });
  expect(tracker.read(["host"], clock(6000))).toEqual({ host: unknownEvidence });
});

it("keeps unknown-pressure samples for admission without establishing duration", () => {
  const tracker = tracked(["host"]);
  tracker.observe({ host: sampleAt(1000) }, clock(1000));
  tracker.observe({ host: sampleAt(4000) }, clock(4000));
  expect(tracker.observe({ host: sampleAt(5000, "unknown") }, clock(5000))).toEqual({
    host: sampleAt(5000, "unknown"),
  });
  expect(tracker.read(["host"], clock(5000))).toEqual({ host: unknownEvidence });
  tracker.observe({ host: sampleAt(6000) }, clock(6000));
  expect(tracker.read(["host"], clock(6000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 0, sampledAtMs: 6000 },
  });
});

it("drops only the domains a collection omits or contradicts", () => {
  const tracker = tracked(["host", "guest"]);
  tracker.observe({ host: sampleAt(1000), guest: sampleAt(1000) }, clock(1000));
  tracker.observe({ host: sampleAt(4000), guest: sampleAt(4000) }, clock(4000));
  const malformedGuest = {
    ...sampleAt(4000),
    ownedBytes: { one: -1 },
  } as unknown as CapacityDomainSample;
  expect(tracker.observe({ host: sampleAt(4000), guest: malformedGuest }, clock(5000))).toEqual({
    host: sampleAt(4000),
  });
  expect(tracker.read(["host", "guest"], clock(5000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 3000, sampledAtMs: 4000 },
    guest: { pressure: "unknown", observedDurationMs: 0, sampledAtMs: null },
  });
  expect(tracker.observe({ host: sampleAt(6000) }, clock(6000))).toEqual({ host: sampleAt(6000) });
  expect(tracker.read(["host", "guest"], clock(6000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 5000, sampledAtMs: 6000 },
    guest: { pressure: "unknown", observedDurationMs: 0, sampledAtMs: null },
  });
});

it("retains watermarks across global invalidation while advancing the generation", () => {
  const tracker = tracked(["host"]);
  tracker.observe({ host: sampleAt(1000) }, clock(1000));
  tracker.observe({ host: sampleAt(4000) }, clock(4000));
  expect(tracker.checkpoint(clock(4000))).toBe(0);
  tracker.invalidate();
  expect(tracker.checkpoint(clock(4000))).toBe(1);
  expect(tracker.read(["host"], clock(4000))).toEqual({ host: unknownEvidence });
  expect(tracker.observe({ host: sampleAt(4000) }, clock(5000))).toEqual({ host: sampleAt(4000) });
  expect(tracker.read(["host"], clock(5000))).toEqual({ host: unknownEvidence });
  tracker.observe({ host: sampleAt(6000) }, clock(6000));
  expect(tracker.read(["host"], clock(6000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 0, sampledAtMs: 6000 },
  });
});

it("clears every window on a clock discontinuity and tolerates the boundary readings", () => {
  const discontinuities = [
    clock(3999, 4000),
    clock(4000, 3999),
    clock(7003, 4000),
    clock(19_001, 19_001),
  ];
  for (const reading of discontinuities) {
    const tracker = tracked(["host"]);
    tracker.observe({ host: sampleAt(1000) }, clock(1000));
    tracker.observe({ host: sampleAt(4000) }, clock(4000));
    expect(tracker.checkpoint(reading)).toBe(1);
    expect(tracker.read(["host"], reading)).toEqual({ host: unknownEvidence });
    expect(tracker.checkpoint(reading)).toBe(1);
    expect(tracker.read(["host"], reading)).toEqual({ host: unknownEvidence });
  }

  const boundaries = [clock(6000, 4000), clock(19_000, 19_000)];
  for (const reading of boundaries) {
    const tracker = tracked(["host"]);
    tracker.observe({ host: sampleAt(1000) }, clock(1000));
    tracker.observe({ host: sampleAt(4000) }, clock(4000));
    expect(tracker.checkpoint(reading)).toBe(0);
    expect(tracker.read(["host"], reading)).toEqual({
      host: { pressure: "normal", observedDurationMs: 3000, sampledAtMs: 4000 },
    });
  }

  const unusable = tracked(["host"]);
  unusable.observe({ host: sampleAt(1000) }, clock(1000));
  let generation = 0;
  for (const reading of [clock(Number.NaN, 1000), clock(1000, -1), clock(1.5, 1000)]) {
    generation += 1;
    expect(unusable.checkpoint(reading)).toBe(generation);
    expect(unusable.read(["host"], clock(1000))).toEqual({ host: unknownEvidence });
  }
});

it("returns independent clones and reports only the declared domains", () => {
  const tracker = tracked(["host"]);
  const source = sampleAt(1000, "normal", { one: 10 });
  const observed = tracker.observe({ host: source }, clock(1000));
  observed.host.ownedBytes.one = 999;
  observed.host.sampledAtMs = 7;
  expect(source.ownedBytes).toEqual({ one: 10 });
  expect(tracker.read(["host", "other"], clock(1000))).toEqual({
    host: { pressure: "normal", observedDurationMs: 0, sampledAtMs: 1000 },
  });
  expect(tracker.read(["other", "third"], clock(1000))).toEqual({});
});
