import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type CapacityReservation, CapacityStore } from "../capacity-store";

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

it("retains all-domain charges across restart and joins without duplicating them", () => {
  const { directory, store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  expect(store.reserve(request, budgets, samples, 100, 15)).toMatchObject({
    admitted: true,
    joined: false,
  });
  const restarted = new CapacityStore(directory);
  expect(restarted.read().reservations).toEqual([request]);
  expect(restarted.reserve(request, budgets, samples, 1000, 15)).toMatchObject({
    admitted: true,
    joined: true,
  });
  const second = {
    ...request,
    environmentId: "two",
    operationId: "operation-two",
    reservationId: "reservation-two",
  };
  expect(restarted.reserve(second, budgets, samples, 100, 15).admitted).toBe(false);
  expect(restarted.read().reservations).toEqual([request]);
});

it("persists no partial reservation when one domain refuses admission", () => {
  const { store } = fixture();
  expect(
    store.reserve(request, { host: budget, guest: budget }, { host: sample }, 100, 15).admitted,
  ).toBe(false);
  expect(store.read()).toEqual({ version: 1, revision: 0, reservations: [] });
});

it("refuses mutation of an existing reservation without settlement proof", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  store.reserve(request, budgets, samples, 100, 15);
  expect(() =>
    store.reserve({ ...request, totals: { host: 0, guest: 0 } }, budgets, samples, 100, 15),
  ).toThrow("retains an earlier");
  expect(store.read().reservations).toEqual([request]);
});

it("admits exec growth atomically while retaining startup charges and omitted domains", () => {
  const { directory, store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  expect(store.reserve(request, budgets, samples, 100, 15).admitted).toBe(true);
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
  expect(store.reserve(exec, budgets, samples, 100, 15, previous)).toMatchObject({
    admitted: true,
    joined: false,
  });
  expect(new CapacityStore(directory).read().reservations).toEqual([
    { ...exec, totals: { host: 20, guest: 70 }, startup: true },
  ]);
  expect(() => store.reserve(exec, budgets, samples, 100, 15, previous)).toThrow(
    "predecessor changed",
  );
});

it("keeps the prior snapshot on refused expansion and retains larger charges on transition", () => {
  const { store } = fixture();
  const budgets = { host: budget, guest: budget };
  const samples = { host: sample, guest: sample };
  expect(store.reserve(request, budgets, samples, 100, 15).admitted).toBe(true);
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
    ),
  ).toMatchObject({ admitted: false, domain: "guest", reason: "memory" });
  expect(store.read()).toEqual(before);
  expect(
    store.reserve({ ...next, totals: { host: 1, guest: 1 } }, budgets, samples, 120, 15, previous),
  ).toMatchObject({ admitted: false, reason: "stale" });
  expect(store.read()).toEqual(before);
  expect(
    store.reserve({ ...next, totals: { host: 1, guest: 1 } }, budgets, samples, 100, 15, previous),
  ).toMatchObject({ admitted: true });
  expect(store.read().reservations).toEqual([next]);
});
