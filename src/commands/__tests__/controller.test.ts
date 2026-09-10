import { afterEach, describe, expect, it, vi } from "vitest";
import { controllerRequest } from "../../core/controller-client";
import { runControllerCommand } from "../controller";

const fixture = vi.hoisted(() => ({ run: vi.fn(), observe: vi.fn() }));
vi.mock("../../core/controller-server", () => ({ runController: fixture.run }));
vi.mock("../../core/controller-client", () => ({ controllerRequest: vi.fn() }));
vi.mock("../../core/controller-observation", () => ({
  collectControllerObservation: fixture.observe,
}));
vi.mock("../../core/controller-binding", () => ({ resolveControllerBinding: vi.fn() }));
vi.mock("../../core/router", () => ({ DEVROUTER_HOME: "/synthetic/router" }));
const capacity = vi.hoisted(() => ({ policy: vi.fn(), factory: vi.fn(), collect: vi.fn() }));
vi.mock("../../core/capacity-policy", () => ({ readCapacityPolicy: capacity.policy }));
vi.mock("../../core/capacity-controller", () => ({ createCapacityController: capacity.factory }));
vi.mock("../../core/capacity-collector", () => ({ collectCapacityDomains: capacity.collect }));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

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

describe("controller command failure reporting", () => {
  it("reports the underlying cause on stderr while keeping the stable JSON contract", async () => {
    fixture.run.mockRejectedValue(
      new Error(
        "could not determine process identity for controller ownership lock at /tmp/owner.lock: ps exited with status 1",
      ),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    await runControllerCommand("run", {});

    expect(stdout.join("")).toBe(
      `${JSON.stringify({ version: 1, ok: false, error: "controller-unavailable" })}\n`,
    );
    expect(stderr.join("")).toContain(
      "controller command failed: could not determine process identity for controller ownership lock",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports the client request cause for observe-style methods", async () => {
    vi.mocked(controllerRequest).mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED /tmp/control.sock"), { code: "ECONNREFUSED" }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    await runControllerCommand("status", {});

    expect(stdout.join("")).toBe(
      `${JSON.stringify({ version: 1, ok: false, error: "controller-unavailable" })}\n`,
    );
    expect(stderr.join("")).toContain("controller command failed: connect ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });

  it("collapses the reported cause to a single bounded line", async () => {
    fixture.run.mockRejectedValue(new Error("first line\nsecond line\n" + "x".repeat(500)));
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    await runControllerCommand("run", {});

    const line = stderr.join("").trimEnd();
    expect(line).not.toContain("\n");
    expect(line.startsWith("controller command failed: ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(300 + "controller command failed: ".length);
  });
});
