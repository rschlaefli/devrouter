import { describe, expect, it } from "vitest";
import { withDockerFailureGuidance } from "../docker-error-guidance";
import type { NetworkCapacityReport } from "../network-capacity";

function exhaustedCapacity(): NetworkCapacityReport {
  return {
    endpoint: "unix:///var/run/docker.sock",
    daemonId: "daemon-1",
    evidence: {
      inventory: "complete",
      containers: "complete",
      routes: "complete",
      reasons: [],
    },
    endpointCapacity: {
      prefixLength: 24,
      totalAddresses: 256,
      conventionalUsableEndpoints: 253,
      reserve: 8,
      availableEndpoints: 245,
      demand: 1,
      status: "available",
    },
    pools: [],
    networks: [],
    allocation: { status: "exhausted", freeBlockCount: 0, blockers: [] },
  };
}

describe("withDockerFailureGuidance", () => {
  it("returns unchanged details when disk-space condition is absent", () => {
    const details = "pull access denied for image";
    expect(withDockerFailureGuidance(details)).toBe(details);
  });

  it("adds non-destructive disk-space guidance for no-space errors", () => {
    const message = withDockerFailureGuidance("write /var/lib/docker: no space left on device");

    expect(message.startsWith("write /var/lib/docker: no space left on device")).toBe(true);
    expect(message.length).toBeGreaterThan("write /var/lib/docker: no space left on device".length);
  });

  it("adds actionable network exhaustion guidance without a broad cleanup command", () => {
    const message = withDockerFailureGuidance("network allocation failed", exhaustedCapacity());

    expect(message.startsWith("network allocation failed")).toBe(true);
    expect(message.length).toBeGreaterThan("network allocation failed".length);
  });

  it("recognizes the Docker address-pool failure without a supplied report", () => {
    const failure = "all predefined address pools have been fully subnetted";
    expect(withDockerFailureGuidance(failure).startsWith(failure)).toBe(true);
    expect(withDockerFailureGuidance(failure).length).toBeGreaterThan(failure.length);
  });
});
