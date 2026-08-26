import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterStatus } from "../../types";
import { printStatus } from "../output";

function makeStatus(): RouterStatus {
  return {
    dockerContext: "default",
    routerRunning: true,
    routerContainerName: "devrouter-traefik",
    boundPorts: {
      web80: true,
      web443: true,
      dashboard8080: true,
      tcp: {},
    },
    tlsEnabled: true,
    certPresent: true,
    tlsConfigured: true,
    networkExists: true,
    repo: {
      path: "/repo",
      configPath: "/repo/.devrouter.yml",
      exists: true,
      valid: true,
      appCount: 2,
      tcpAppCount: 0,
      managedRuntime: {
        mode: "managed",
        status: "drifted",
        profile: "ai,mcp",
        activeProfile: "ai",
        workspace: "feature",
        devpodId: "devpod-feature",
        composeProject: "feature-project",
        desired: {
          apps: ["chat"],
          services: ["litellm", "mcp-doc-query"],
          processes: ["chat"],
        },
        active: {
          apps: ["chat"],
          services: ["litellm"],
          processes: [],
        },
        serviceStatuses: {
          "mcp-doc-query": "missing",
          litellm: "healthy",
        },
        processStatuses: {
          chat: "drifted",
        },
        drift: ["process chat is not running"],
        sourceConfigSha256: "a".repeat(64),
        effectiveConfigSha256: "b".repeat(64),
        transitionPhase: "process-reconcile",
      },
    },
    insights: {
      httpRoutingReady: true,
      tcpRoutingReady: true,
      nextSteps: [],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printStatus", () => {
  it("prints desired, active, and drift information without resource values", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    printStatus(makeStatus());

    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("Runtime status");
    expect(output).toContain("ai,mcp");
    expect(output).toContain("litellm, mcp-doc-query");
    expect(output).toContain("litellm=healthy, mcp-doc-query=missing");
    expect(output).toContain("process chat is not running");
    expect(output).toContain("Source config SHA-256");
  });
});
