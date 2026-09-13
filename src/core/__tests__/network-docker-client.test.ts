import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listContainers } from "../docker";
import { withNetworkEffectGuard } from "../network-effect-scope";

const clients = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    constructor(options: unknown) {
      clients.options.push(options);
    }
    async listContainers() {
      return [];
    }
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  clients.options = [];
});
describe("Docker client allocation scope", () => {
  it("uses the saved socket without resolving an ambient context", async () => {
    await withNetworkEffectGuard(
      () => {},
      () => listContainers(),
      "unix:///synthetic/pinned.sock",
    );
    expect(clients.options).toEqual([{ socketPath: "/synthetic/pinned.sock" }]);
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("preserves context selection outside the allocation scope", async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "synthetic-context" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "unix:///synthetic/current.sock" } as never);
    await listContainers();
    expect(clients.options).toEqual([{ socketPath: "/synthetic/current.sock" }]);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});
