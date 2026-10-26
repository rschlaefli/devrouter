import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { readHostWakeEpoch } from "../host-wake";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
beforeEach(() => {
  vi.mocked(spawnSync).mockReset();
});

it("reads the exact kernel wake identity without narrowing a 64-bit counter", () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "9007199254740993\n" } as never);
  expect(readHostWakeEpoch("darwin")).toBe("9007199254740993");
  expect(spawnSync).toHaveBeenCalledWith(
    "/usr/sbin/sysctl",
    ["-n", "kern.wake_abs_time"],
    expect.objectContaining({ timeout: 250, maxBuffer: 256, encoding: "utf8" }),
  );
});

it.each([
  "",
  "-1",
  "1.5",
  "1e3",
  "01",
  "1\n2",
  "18446744073709551616",
])("treats malformed wake evidence %j as unavailable", (stdout) => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as never);
  expect(readHostWakeEpoch("darwin")).toBeNull();
});

it("distinguishes an unsupported host from an unavailable supported probe", () => {
  expect(readHostWakeEpoch("linux")).toBeUndefined();
  expect(spawnSync).not.toHaveBeenCalled();
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as never);
  expect(readHostWakeEpoch("darwin")).toBeNull();
  vi.mocked(spawnSync).mockReturnValue({
    status: null,
    stdout: "0",
    error: new Error("probe timeout"),
  } as never);
  expect(readHostWakeEpoch("darwin")).toBeNull();
  vi.mocked(spawnSync).mockImplementation(() => {
    throw new Error("probe unavailable");
  });
  expect(readHostWakeEpoch("darwin")).toBeNull();
});

it("accepts the kernel zero baseline before the first wake", () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "0\n" } as never);
  expect(readHostWakeEpoch("darwin")).toBe("0");
});
