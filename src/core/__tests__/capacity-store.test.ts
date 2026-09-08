import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type CapacityReservation,
  CapacitySnapshotChangedError,
  CapacityStore,
} from "../capacity-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const budget = { capacityBytes: 100, protectedHeadroomBytes: 10, startupSlots: 1, heavySlots: 1 };
const sample = {
  sampledAtMs: 100,
  pressure: "normal" as const,
  unmanagedBytes: 0,
  sharedBytes: 0,
  ownedBytes: {},
};
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-store-"));
  directories.push(directory);
  return { directory, store: new CapacityStore(directory) };
}
const request: CapacityReservation = {
  environmentId: "one",
  operationId: "operation-one",
  reservationId: "reservation-one",
  policyRevision: 1,
  totals: { host: 20, guest: 50 },
  startup: true,
  heavy: false,
};

it("reduces only the exact retained phase and never resurrects a stopped row", () => {
  const { store } = fixture();
  expect(
    store.reserve(
      request,
      { host: budget, guest: budget },
      { host: sample, guest: sample },
      100,
      15,
      undefined,
      0,
    ).admitted,
  ).toBe(true);
  const target = { ...request, totals: { host: 10, guest: 20 }, startup: false };
  const before = store.read();
  expect(() => store.reduceAfterPhase(target, 0)).toThrow(CapacitySnapshotChangedError);
  expect(() =>
    store.reduceAfterPhase({ ...target, operationId: "different" }, before.revision),
  ).toThrow();
  expect(() =>
    store.reduceAfterPhase({ ...target, totals: { host: 21, guest: 20 } }, before.revision),
  ).toThrow();
  expect(() =>
    store.reduceAfterPhase({ ...target, totals: { host: 10 } }, before.revision),
  ).toThrow();
  expect(() => store.reduceAfterPhase({ ...target, heavy: true }, before.revision)).toThrow();
  expect(store.read()).toEqual(before);
  store.reduceAfterPhase(target, before.revision);
  expect(store.read().reservations).toEqual([target]);
  store.reduceAfterPhase(target, store.read().revision);
  expect(store.read().reservations).toEqual([target]);
  store.settleEnvironmentAfterStop(request.environmentId, store.read().revision);
  const stopped = store.read();
  expect(() => store.reduceAfterPhase(target, stopped.revision)).toThrow();
  expect(store.read()).toEqual(stopped);
});

it("retains all-domain charges across restart and joins without duplicating them", () => {
  const { directory, store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  const initialRevision = store.read().revision;
  expect(
    store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision),
  ).toMatchObject({
    admitted: true,
    joined: false,
  });
  const restarted = new CapacityStore(directory);
  expect(restarted.read().reservations).toEqual([request]);
  const joinedRevision = restarted.read().revision;
  expect(
    restarted.reserve(request, budgets, samples, 100, 15, undefined, joinedRevision),
  ).toMatchObject({
    admitted: true,
    joined: true,
  });
  const second = {
    ...request,
    environmentId: "two",
    operationId: "operation-two",
    reservationId: "reservation-two",
  };
  const secondRevision = restarted.read().revision;
  expect(
    restarted.reserve(second, budgets, samples, 100, 15, undefined, secondRevision).admitted,
  ).toBe(false);
  expect(restarted.read().reservations).toEqual([request]);
});

it.each([
  "stale",
  "pressured",
  "unknown",
] as const)("requires fresh admission when joining after interrupted publication (%s)", (condition) => {
  const { directory, store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  const initialRevision = store.read().revision;
  expect(
    store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision).admitted,
  ).toBe(true);
  const before = store.read();
  const restarted = new CapacityStore(directory);
  const expectedRevision = restarted.read().revision;
  expect(
    restarted.reserve(
      request,
      budgets,
      {
        ...samples,
        guest: { ...sample, sampledAtMs: condition === "stale" ? 1000 : 100 },
        host: { ...sample, pressure: condition === "stale" ? "normal" : condition },
      },
      condition === "stale" ? 1000 : 100,
      15,
      undefined,
      expectedRevision,
    ),
  ).toMatchObject({
    admitted: false,
    domain: "host",
    reason: condition === "pressured" ? "pressure" : condition,
  });
  expect(restarted.read()).toEqual(before);
});

it("persists no partial reservation when one domain refuses admission", () => {
  const { store } = fixture();
  const expectedRevision = store.read().revision;
  expect(
    store.reserve(
      request,
      { host: budget, guest: budget },
      { host: sample },
      100,
      15,
      undefined,
      expectedRevision,
    ).admitted,
  ).toBe(false);
  expect(store.read()).toEqual({ version: 1, revision: 0, reservations: [] });
});

it("fences an empty stop settlement and requires a fresh revision for a new reserve", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };

  expect(store.settleEnvironmentAfterStop("one", 0)).toEqual({ settled: false, revision: 1 });
  expect(store.read()).toEqual({ version: 1, revision: 1, reservations: [] });
  const reserveConflict = () => store.reserve(request, budgets, samples, 100, 15, undefined, 0);
  expect(reserveConflict).toThrow("Capacity snapshot changed.");
  expect(reserveConflict).toThrowError(CapacitySnapshotChangedError);
  const fresh = {
    ...request,
    environmentId: "fresh",
    operationId: "operation-fresh",
    reservationId: "reservation-fresh",
  };
  expect(store.reserve(fresh, budgets, samples, 100, 15, undefined, 1)).toMatchObject({
    admitted: true,
    revision: 2,
  });
});

it("rejects a reserve without an expected snapshot revision", () => {
  const { store } = fixture();
  const reserve = store.reserve as unknown as (...args: unknown[]) => unknown;

  expect(() =>
    reserve(request, { host: budget, guest: budget }, { host: sample, guest: sample }, 100, 15),
  ).toThrow("Invalid capacity expected revision.");
  expect(store.read()).toEqual({ version: 1, revision: 0, reservations: [] });
});

it("settles exactly one environment and preserves the other reservation", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  const other = {
    ...request,
    environmentId: "two",
    operationId: "operation-two",
    reservationId: "reservation-two",
    totals: { host: 10, guest: 10 },
    startup: false,
  };

  const initialRevision = store.read().revision;
  store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision);
  const otherRevision = store.read().revision;
  store.reserve(other, budgets, samples, 100, 15, undefined, otherRevision);
  const before = store.read();
  expect(store.settleEnvironmentAfterStop("one", before.revision)).toEqual({
    settled: true,
    revision: before.revision + 1,
  });
  expect(store.read()).toEqual({
    version: 1,
    revision: before.revision + 1,
    reservations: [other],
  });
});

it("rejects settlement against a changed snapshot without mutation", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };

  const initialRevision = store.read().revision;
  store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision);
  const oldRevision = store.read().revision;
  const other = {
    ...request,
    environmentId: "two",
    operationId: "operation-two",
    reservationId: "reservation-two",
    totals: { host: 10, guest: 10 },
    startup: false,
  };
  const otherRevision = store.read().revision;
  store.reserve(other, budgets, samples, 100, 15, undefined, otherRevision);
  const before = store.read();

  const settlementConflict = () => store.settleEnvironmentAfterStop("one", oldRevision);
  expect(settlementConflict).toThrow("Capacity snapshot changed.");
  expect(settlementConflict).toThrowError(CapacitySnapshotChangedError);
  expect(store.read()).toEqual(before);
});

it("refuses mutation of an existing reservation without settlement proof", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  const initialRevision = store.read().revision;
  store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision);
  const expectedRevision = store.read().revision;
  expect(() =>
    store.reserve(
      { ...request, totals: { host: 0, guest: 0 } },
      budgets,
      samples,
      100,
      15,
      undefined,
      expectedRevision,
    ),
  ).toThrow("retains an earlier");
  expect(store.read().reservations).toEqual([request]);
});

it("admits exec growth atomically while retaining startup charges and omitted domains", () => {
  const { directory, store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  const initialRevision = store.read().revision;
  expect(
    store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision).admitted,
  ).toBe(true);
  const previous = {
    revision: store.read().revision,
    reservationId: request.reservationId,
    operationId: request.operationId,
  };
  const exec = {
    ...request,
    operationId: "exec-one",
    reservationId: "exec-reservation",
    totals: { guest: 70 },
    startup: false,
    heavy: true,
  };
  expect(store.reserve(exec, budgets, samples, 100, 15, previous, previous.revision)).toMatchObject(
    {
      admitted: true,
      joined: false,
    },
  );
  expect(new CapacityStore(directory).read().reservations).toEqual([
    { ...exec, totals: { host: 20, guest: 70 }, startup: true },
  ]);
  const expectedRevision = store.read().revision;
  expect(() => store.reserve(exec, budgets, samples, 100, 15, previous, expectedRevision)).toThrow(
    "predecessor changed",
  );
});

it("keeps the prior snapshot on refused expansion and retains larger charges on transition", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  const initialRevision = store.read().revision;
  expect(
    store.reserve(request, budgets, samples, 100, 15, undefined, initialRevision).admitted,
  ).toBe(true);
  const before = store.read();
  const previous = {
    revision: before.revision,
    reservationId: request.reservationId,
    operationId: request.operationId,
  };
  const next = { ...request, operationId: "next", reservationId: "next-reservation" };
  expect(
    store.reserve(
      { ...next, totals: { host: 30, guest: 91 } },
      budgets,
      samples,
      100,
      15,
      previous,
      previous.revision,
    ),
  ).toMatchObject({ admitted: false, domain: "guest", reason: "memory" });
  expect(store.read()).toEqual(before);
  expect(
    store.reserve(
      { ...next, totals: { host: 1, guest: 1 } },
      budgets,
      samples,
      120,
      15,
      previous,
      previous.revision,
    ),
  ).toMatchObject({ admitted: false, reason: "stale" });
  expect(store.read()).toEqual(before);
  expect(
    store.reserve(
      { ...next, totals: { host: 1, guest: 1 } },
      budgets,
      samples,
      100,
      15,
      previous,
      previous.revision,
    ),
  ).toMatchObject({ admitted: true });
  expect(store.read().reservations).toEqual([next]);
});
