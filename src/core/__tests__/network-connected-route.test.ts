import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkClaim } from "../network-claims";
import { inspectClaimedBridge } from "../network-connected-route";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const networkId = "a".repeat(64);
const claim = {
  endpoint: "unix:///synthetic.sock",
  subnet: "10.88.0.0/26",
  prefix: 26,
} as NetworkClaim;
const bridge = `br-${networkId.slice(0, 12)}`;
function evidence(overrides: Record<string, unknown> = {}) {
  vi.mocked(spawnSync).mockReturnValueOnce({
    status: 0,
    stdout: JSON.stringify({
      id: networkId,
      driver: "bridge",
      options: {},
      ipam: [{ Subnet: claim.subnet, Gateway: "10.88.0.1" }],
    }),
  } as never);
  vi.mocked(spawnSync).mockReturnValueOnce({
    status: 0,
    stdout: JSON.stringify([
      {
        ifname: bridge,
        linkinfo: { info_kind: "bridge" },
        addr_info: [{ family: "inet", local: "10.88.0.1", prefixlen: 26 }],
        ...overrides,
      },
    ]),
  } as never);
}
beforeEach(() => vi.resetAllMocks());
describe("claimed connected interface evidence", () => {
  it("requires the exact Docker subnet, real bridge and gateway before exemption", () => {
    evidence();
    expect(inspectClaimedBridge(claim, networkId)).toBe(bridge);
    expect(vi.mocked(spawnSync).mock.calls.map(([command]) => command)).toEqual(["docker", "ip"]);
    expect(vi.mocked(spawnSync).mock.calls[0][1]?.slice(0, 2)).toEqual(["--host", claim.endpoint]);
  });
  it.each([
    { ifname: "foreign" },
    { linkinfo: { info_kind: "veth" } },
    { addr_info: [{ family: "inet", local: "10.88.0.2", prefixlen: 26 }] },
    { addr_info: [{ family: "inet", local: "10.88.0.1", prefixlen: 24 }] },
    { addr_info: [] },
  ])("denies a mismatched or incomplete interface", (override) => {
    evidence(override);
    expect(() => inspectClaimedBridge(claim, networkId)).toThrow();
  });
  it("fails closed when the interface command is unavailable", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: networkId,
          driver: "bridge",
          options: {},
          ipam: [{ Subnet: claim.subnet, Gateway: "10.88.0.1" }],
        }),
      } as never)
      .mockReturnValueOnce({ status: 1, stdout: "" } as never);
    expect(() => inspectClaimedBridge(claim, networkId)).toThrow();
    expect(vi.mocked(spawnSync).mock.calls.map(([command]) => command)).toEqual(["docker", "ip"]);
  });
});
