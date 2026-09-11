import { execFileSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { runControllerProbeStatus } from "../controller-probe";
import { observeControllerProcess } from "../controller-process-observation";

vi.mock("../controller-probe", async (original) => ({
  ...(await original<typeof import("../controller-probe")>()),
  runControllerProbeStatus: vi.fn(),
}));
beforeEach(() => vi.mocked(runControllerProbeStatus).mockReset());
const container = "a".repeat(64);
const signal = new AbortController().signal;

it("returns only validated transient process identity from the bounded probe", async () => {
  vi.mocked(runControllerProbeStatus).mockResolvedValue({
    output: "123 456 fingerprint\n",
    code: 0,
  });
  await expect(observeControllerProcess(container, "web", signal)).resolves.toEqual({
    kind: "present",
    identity: "123 456 fingerprint",
  });
  const [command, args, actualSignal] = vi.mocked(runControllerProbeStatus).mock.calls[0];
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

it("reports the probe's positive absence as a missing process", async () => {
  vi.mocked(runControllerProbeStatus).mockResolvedValue({ output: "", code: 3 });
  await expect(observeControllerProcess(container, "web", signal)).resolves.toEqual({
    kind: "absent",
  });
});

it("keeps any other non-zero probe outcome unavailable", async () => {
  vi.mocked(runControllerProbeStatus).mockResolvedValue({ output: "noise", code: 1 });
  await expect(observeControllerProcess(container, "web", signal)).rejects.toThrow(
    "Process observation is unavailable",
  );
});

it("rejects ambiguous process evidence without exposing probe output", async () => {
  vi.mocked(runControllerProbeStatus).mockResolvedValue({
    output: "untrusted diagnostic output",
    code: 0,
  });
  await expect(observeControllerProcess(container, "web", signal)).rejects.toThrow(
    "Process observation is unavailable.",
  );
});

it("rejects invalid target identity before launching any process", async () => {
  await expect(observeControllerProcess("other-container", "web", signal)).rejects.toThrow();
  await expect(observeControllerProcess(container, "../web", signal)).rejects.toThrow();
  expect(runControllerProbeStatus).not.toHaveBeenCalled();
});
