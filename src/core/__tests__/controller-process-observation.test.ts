import { execFileSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { runControllerProbe } from "../controller-probe";
import { observeControllerProcess } from "../controller-process-observation";

vi.mock("../controller-probe", () => ({ runControllerProbe: vi.fn() }));
beforeEach(() => vi.mocked(runControllerProbe).mockReset());
const container = "a".repeat(64);
const signal = new AbortController().signal;

it("returns only validated transient process identity from the bounded probe", async () => {
  vi.mocked(runControllerProbe).mockResolvedValue("123 456 fingerprint\n");
  await expect(observeControllerProcess(container, "web", signal)).resolves.toBe(
    "123 456 fingerprint",
  );
  const [command, args, actualSignal] = vi.mocked(runControllerProbe).mock.calls[0];
  expect(command).toBe("docker");
  expect(args.slice(0, 7)).toEqual([
    "exec",
    container,
    "timeout",
    "--signal=KILL",
    "2s",
    "bash",
    "-c",
  ]);
  expect(args.slice(-2)).toEqual(["observer", "web"]);
  expect(actualSignal).toBe(signal);
  execFileSync("bash", ["-n"], { input: args[7], timeout: 1000 });
});

it("rejects ambiguous process evidence without exposing probe output", async () => {
  vi.mocked(runControllerProbe).mockResolvedValue("untrusted diagnostic output");
  await expect(observeControllerProcess(container, "web", signal)).rejects.toThrow(
    "Process observation is unavailable.",
  );
});

it("rejects invalid target identity before launching any process", async () => {
  await expect(observeControllerProcess("other-container", "web", signal)).rejects.toThrow();
  await expect(observeControllerProcess(container, "../web", signal)).rejects.toThrow();
  expect(runControllerProbe).not.toHaveBeenCalled();
});
