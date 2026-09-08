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
