import { beforeEach, describe, expect, it, vi } from "vitest";
import { processBirthIdentity } from "../file-lock";
import {
  assertNetworkOperationCurrent,
  networkOperationSettled,
  readNetworkOperationAuthority,
} from "../network-lifecycle";
import { readReliabilityOperation } from "../reliability-operation-store";

vi.mock("../file-lock", () => ({ processBirthIdentity: vi.fn(() => "birth") }));
vi.mock("../reliability-operation-store", () => ({ readReliabilityOperation: vi.fn() }));
const identity = { repoPath: "/synthetic", workspace: "synthetic", provider: "devsy" as const };
const fence = {
  environmentId: "environment",
  intentRevision: 1,
  runtimeGeneration: 1,
  controllerEpoch: 1,
};
function record() {
  return {
    state: {
      ...fence,
      operation: { id: "operation", drained: false, status: "RUNNING" },
      operationHistory: [],
    },
    worker: { id: "worker", pid: process.pid, birth: "birth", operationId: "operation" },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readReliabilityOperation).mockReturnValue(record() as never);
});
describe("network allocation lifecycle evidence", () => {
  it("allows a new exact worker to reconcile a drained prior operation without settling itself", () => {
    const authority = readNetworkOperationAuthority(identity);
    vi.mocked(readReliabilityOperation).mockReturnValue({
      ...record(),
      state: {
        ...record().state,
        operationHistory: [{ id: "prior", drained: true, status: "INTERRUPTED" }],
      },
    } as never);
    expect(networkOperationSettled(identity, "prior", authority)).toBe(true);
    expect(networkOperationSettled(identity, "operation", authority)).toBe(false);
    expect(networkOperationSettled(identity, "prior")).toBe(false);
    expect(() =>
      networkOperationSettled(identity, "prior", { ...authority, workerId: "foreign" }),
    ).toThrow();
  });
  it("requires the current process and exact worker fence", () => {
    const authority = readNetworkOperationAuthority(identity);
    expect(authority).toEqual({ operationId: "operation", workerId: "worker", fence });
    expect(() => assertNetworkOperationCurrent(identity, authority)).not.toThrow();
    vi.mocked(readReliabilityOperation).mockReturnValue({
      ...record(),
      state: { ...record().state, runtimeGeneration: 2 },
    } as never);
    expect(() => assertNetworkOperationCurrent(identity, authority)).toThrow();
  });
  it("does not turn an absent worker or PID reuse into allocation authority", () => {
    vi.mocked(processBirthIdentity).mockReturnValueOnce("replacement");
    expect(() => readNetworkOperationAuthority(identity)).toThrow();
    vi.mocked(readReliabilityOperation).mockReturnValue({ ...record(), worker: null } as never);
    expect(() => readNetworkOperationAuthority(identity)).toThrow();
  });
  it("requires historical drain and no current worker before no-effect recovery", () => {
    expect(networkOperationSettled(identity, "operation")).toBe(false);
    vi.mocked(readReliabilityOperation).mockReturnValue({
      ...record(),
      worker: null,
      state: {
        ...record().state,
        operationHistory: [{ id: "operation", drained: true, status: "INTERRUPTED" }],
      },
    } as never);
    expect(networkOperationSettled(identity, "operation")).toBe(true);
    expect(networkOperationSettled(identity, "different")).toBe(false);
  });
});
