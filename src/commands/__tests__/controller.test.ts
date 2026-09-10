import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/controller-server", () => ({ runController: vi.fn() }));
vi.mock("../../core/controller-client", () => ({ controllerRequest: vi.fn() }));
vi.mock("../../core/controller-binding", () => ({
  resolveControllerBinding: vi.fn(),
}));
vi.mock("../../core/controller-observation", () => ({
  collectControllerObservation: vi.fn(),
}));
vi.mock("../../core/router", () => ({ DEVROUTER_HOME: "/tmp/devrouter-controller-test" }));

import { controllerRequest } from "../../core/controller-client";
import { runController } from "../../core/controller-server";
import { runControllerCommand } from "../controller";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("controller command failure reporting", () => {
  it("reports the underlying cause on stderr while keeping the stable JSON contract", async () => {
    vi.mocked(runController).mockRejectedValue(
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
    vi.mocked(runController).mockRejectedValue(
      new Error("first line\nsecond line\n" + "x".repeat(500)),
    );
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
