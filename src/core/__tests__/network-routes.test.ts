import { describe, expect, it } from "vitest";
import { collectNetworkRoutes, parseLinuxNetworkRoutes } from "../network-routes";

describe("Linux route evidence", () => {
  it("retains concrete split tunnel and host routes while omitting default", () => {
    expect(
      parseLinuxNetworkRoutes(
        JSON.stringify([
          { dst: "default", dev: "tun0" },
          { dst: "0.0.0.0/1", dev: "tun0" },
          { dst: "10.1.2.3", dev: "eth0", table: "local" },
        ]),
      ),
    ).toEqual({
      status: "complete",
      routes: [
        { cidr: "0.0.0.0/1", interface: "tun0", source: "host" },
        { cidr: "10.1.2.3/32", interface: "eth0", source: "host" },
      ],
    });
  });
  it("fails closed for malformed or unqualified route sources", () => {
    expect(parseLinuxNetworkRoutes('[{"dst":"10.0.0.0/8"}]').status).toBe("unknown");
    expect(parseLinuxNetworkRoutes("truncated").status).toBe("unknown");
    expect(
      collectNetworkRoutes({ platform: "darwin", endpoint: "unix:///synthetic.sock" }).status,
    ).toBe("unknown");
  });
});

describe("claimed bridge route exemption", () => {
  it("retains wider routes and identical routes on foreign interfaces", async () => {
    const { exemptClaimedConnectedRoutes } = await import("../network-connected-route");
    const routes = [
      { cidr: "10.88.0.0/26", interface: "br-owned" },
      { cidr: "10.88.0.1/32", interface: "br-owned" },
      { cidr: "10.88.0.0/24", interface: "br-owned" },
      { cidr: "10.88.0.0/26", interface: "tun0" },
    ];
    expect(
      exemptClaimedConnectedRoutes({ status: "complete", routes }, "10.88.0.0/26", "br-owned")
        .routes,
    ).toEqual(routes.slice(2));
  });
});
