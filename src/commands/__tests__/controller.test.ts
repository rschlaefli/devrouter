import { afterEach, expect, it, vi } from "vitest";
import { runControllerCommand } from "../controller";

const fixture = vi.hoisted(() => ({ run: vi.fn(), observe: vi.fn() }));
vi.mock("../../core/controller-server", () => ({ runController: fixture.run }));
vi.mock("../../core/controller-observation", () => ({
  collectControllerObservation: fixture.observe,
}));
vi.mock("../../core/controller-binding", () => ({ resolveControllerBinding: vi.fn() }));
vi.mock("../../core/router", () => ({ DEVROUTER_HOME: "/synthetic/router" }));
afterEach(() => vi.resetAllMocks());
it("keeps ordinary controller startup observation-only", async () => {
  await runControllerCommand("run", {});
  expect(fixture.run).toHaveBeenCalledOnce();
  expect(fixture.run.mock.calls[0][0].createOperations).toBeUndefined();
  expect(fixture.run.mock.calls[0][0].collect).toBe(fixture.observe);
});
it("passes an internal operations factory without consuming its startup authority", async () => {
  const createOperations = vi.fn();
  const before = process.listenerCount("SIGTERM");
  await runControllerCommand("run", {}, undefined, { createOperations });
  expect(fixture.run.mock.calls[0][0].createOperations).toBe(createOperations);
  expect(createOperations).not.toHaveBeenCalled();
  expect(process.listenerCount("SIGTERM")).toBe(before);
});
