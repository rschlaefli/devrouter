import { afterEach, expect, it, vi } from "vitest";
import { runControllerCommand } from "../controller";

const fixture = vi.hoisted(() => ({ run: vi.fn(), observe: vi.fn() }));
vi.mock("../../core/controller-server", () => ({ runController: fixture.run }));
vi.mock("../../core/controller-observation", () => ({
  collectControllerObservation: fixture.observe,
}));
vi.mock("../../core/controller-binding", () => ({ resolveControllerBinding: vi.fn() }));
vi.mock("../../core/router", () => ({ DEVROUTER_HOME: "/synthetic/router" }));
const capacity = vi.hoisted(() => ({ policy: vi.fn(), factory: vi.fn(), collect: vi.fn() }));
vi.mock("../../core/capacity-policy", () => ({ readCapacityPolicy: capacity.policy }));
vi.mock("../../core/capacity-controller", () => ({
  createCapacityController: capacity.factory,
}));
vi.mock("../../core/capacity-collector", () => ({
  collectCapacityDomains: capacity.collect,
}));
afterEach(() => vi.resetAllMocks());
it("keeps ordinary controller startup observation-only without an enabled policy", async () => {
  capacity.policy.mockReturnValue(undefined);
  await runControllerCommand("run", {});
  expect(fixture.run).toHaveBeenCalledOnce();
  const createOperations = fixture.run.mock.calls[0][0].createOperations;
  expect(fixture.run.mock.calls[0][0].collect).toBe(fixture.observe);
  const startup = { directory: "/synthetic", consumeStartup: vi.fn() };
  expect(createOperations(startup)).toBeUndefined();
  expect(startup.consumeStartup).not.toHaveBeenCalled();
  expect(capacity.factory).not.toHaveBeenCalled();
});
it("activates the capacity factory only for an enabled policy", async () => {
  const policy = { admissions: "enabled" };
  capacity.policy.mockReturnValue(policy);
  const operations = { submit: vi.fn(), watch: vi.fn() };
  capacity.factory.mockReturnValue(operations);
  await runControllerCommand("run", {});
  const createOperations = fixture.run.mock.calls[0][0].createOperations;
  const startup = { directory: "/synthetic", consumeStartup: vi.fn() };
  expect(createOperations(startup)).toBe(operations);
  expect(capacity.factory).toHaveBeenCalledOnce();
  const options = capacity.factory.mock.calls[0][0];
  expect(options.directory).toBe("/synthetic/router/controller");
  expect(options.controller).toBe(startup);
  options.collect(new AbortController().signal);
  expect(capacity.collect).toHaveBeenCalledWith(policy, expect.any(AbortSignal));
});
it("passes an internal operations factory without consuming its startup authority", async () => {
  const createOperations = vi.fn();
  const before = process.listenerCount("SIGTERM");
  await runControllerCommand("run", {}, undefined, { createOperations });
  expect(fixture.run.mock.calls[0][0].createOperations).toBe(createOperations);
  expect(createOperations).not.toHaveBeenCalled();
  expect(process.listenerCount("SIGTERM")).toBe(before);
});
