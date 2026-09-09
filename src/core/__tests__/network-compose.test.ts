import { describe, expect, it } from "vitest";

import {
  classifyComposeNetworkEligibility,
  deriveComposeNetworkDemand,
  deriveComposeNetworkOverlay,
  extendDockerComposeFile,
  fingerprintComposeNetworkModel,
  SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS,
} from "../network-compose";

const compose = {
  services: {
    web: {
      profiles: ["full"],
      deploy: { replicas: 2 },
      networks: {
        default: { aliases: ["web"] },
        devnet: { aliases: ["web-shared"] },
      },
      environment: { SECRET_TOKEN: "synthetic-secret" },
    },
    worker: {
      profiles: ["worker"],
      replicas: 3,
      networks: { default: { aliases: ["worker"] } },
    },
  },
  networks: {
    default: { name: "synthetic_project_default", driver: "bridge" },
    devnet: { name: "synthetic_devnet", external: true },
  },
};

describe("Compose network eligibility", () => {
  it("accepts one implicit default bridge and preserves an external devnet", () => {
    const result = classifyComposeNetworkEligibility({
      compose,
      authoredNetworks: {
        devnet: { external: true, name: "shared-devnet" },
      },
    });

    expect(result.status).toBe("eligible");
    expect(result.privateNetworks).toEqual(["default"]);
    expect(result.externalNetworks).toEqual(["devnet"]);
    expect(result.reasons).toEqual([]);
  });

  it("rejects multiple private networks and explicit ownership controls", () => {
    const result = classifyComposeNetworkEligibility({
      compose: {
        services: { app: {} },
        networks: {
          default: { driver: "bridge" },
          backend: { driver: "bridge" },
        },
      },
      authoredNetworks: {
        default: { name: "fixed-default" },
        backend: { ipam: { config: [{ subnet: "10.20.0.0/24" }] } },
      },
    });

    expect(result.status).toBe("unsupported");
    expect(result.reasons.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "multiple-private-networks",
        "explicit-authored-name",
        "explicit-authored-ipam",
      ]),
    );
  });

  it("rejects authored external declarations even when external is false", () => {
    const result = classifyComposeNetworkEligibility({
      compose: { services: { app: {} }, networks: { default: { driver: "bridge" } } },
      authoredNetworks: { default: { external: false } },
    });

    expect(result.status).toBe("unsupported");
    expect(result.reasons.map(({ code }) => code)).toContain("explicit-authored-external");
  });

  it("reports primary and image modes as unsupported metadata", () => {
    for (const mode of ["primary", "image"]) {
      const result = classifyComposeNetworkEligibility({ compose, metadata: { mode } });
      expect(result.status).toBe("unsupported");
      expect(result.reasons.map(({ code }) => code)).toContain("mode-unsupported");
    }
  });

  it("returns unknown for malformed topology instead of treating it as private capacity", () => {
    const result = classifyComposeNetworkEligibility({
      compose: {
        services: { app: { networks: "default" } },
        networks: { default: { driver: 7 } },
      },
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["malformed-service-networks", "malformed-network-driver"]),
    );
  });
});

describe("Compose network demand", () => {
  it("counts the full service/profile union, network participation, helpers, retained endpoints, and surge", () => {
    const result = deriveComposeNetworkDemand({
      compose,
      helperEndpoints: 2,
      retainedEndpoints: 4,
      recreationSurge: 3,
      capacity: { prefixLength: 26 },
    });

    expect(result.status).toBe("known");
    expect(result.observed.serviceEndpoints).toBe(5);
    expect(result.observed.helperEndpoints).toBe(2);
    expect(result.observed.retainedEndpoints).toBe(4);
    expect(result.observed.recreationSurge).toBe(3);
    expect(result.lowerBound).toBe(14);
    expect(result.upperBound).toBe(14);
    expect(result.capacity).toMatchObject({
      availableEndpoints: 53,
      requiredEndpoints: 14,
      status: "fit",
    });
  });

  it("counts exact /26 headroom at 53 endpoints and rejects one over", () => {
    const base = {
      compose: { services: {} },
      capacity: { prefixLength: 26 },
    };
    const fit = deriveComposeNetworkDemand({ ...base, retainedEndpoints: 53 });
    const over = deriveComposeNetworkDemand({ ...base, retainedEndpoints: 54 });

    expect(fit.capacity).toMatchObject({ availableEndpoints: 53, headroom: 0, status: "fit" });
    expect(over.capacity).toMatchObject({
      availableEndpoints: 53,
      headroom: -1,
      status: "insufficient",
    });
    expect(over.reasons.map(({ code }) => code)).toContain("insufficient-endpoint-headroom");
  });

  it("keeps dynamic or malformed replicas unknown without a safe bound", () => {
    const dynamic = deriveComposeNetworkDemand({
      compose: { services: { worker: { deploy: { replicas: "dynamic" } } } },
    });
    const malformed = deriveComposeNetworkDemand({
      compose: { services: { worker: { replicas: -1 } } },
    });

    expect(dynamic.status).toBe("unknown");
    expect(dynamic.reasons.map(({ code }) => code)).toContain("unbounded-replicas");
    expect(malformed.status).toBe("unknown");
    expect(malformed.reasons.map(({ code }) => code)).toContain("malformed-replicas");
  });

  it("accepts dynamic scale only with the declared full-lifecycle upper-bound semantics", () => {
    const composeWithDynamicScale = { services: { worker: { replicas: "dynamic" } } };
    const safe = deriveComposeNetworkDemand({
      compose: composeWithDynamicScale,
      endpointUpperBound: { value: 20, semantics: SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS },
    });
    const unsafe = deriveComposeNetworkDemand({
      compose: composeWithDynamicScale,
      endpointUpperBound: 20,
    });
    const contradictory = deriveComposeNetworkDemand({
      compose: { services: { worker: { replicas: 3 } } },
      endpointUpperBound: { value: 2, semantics: SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS },
    });

    expect(safe).toMatchObject({ status: "known", upperBound: 20, upperBoundSource: "explicit" });
    expect(safe.reasons.map(({ code }) => code)).not.toContain("unbounded-replicas");
    expect(unsafe.status).toBe("unknown");
    expect(unsafe.reasons.map(({ code }) => code)).toContain("unsafe-endpoint-upper-bound");
    expect(contradictory.status).toBe("unknown");
    expect(contradictory.reasons.map(({ code }) => code)).toContain(
      "contradictory-endpoint-upper-bound",
    );
  });
});

describe("Compose network overlay and effective config", () => {
  it("derives only the Compose-owned default IPAM overlay", () => {
    const result = deriveComposeNetworkOverlay("10.44.0.0/26");

    expect(result).toEqual({
      status: "ready",
      overlay: { networks: { default: { ipam: { config: [{ subnet: "10.44.0.0/26" }] } } } },
      reasons: [],
    });
  });

  it("clones native config and extends only dockerComposeFile", () => {
    const nativeConfig = {
      dockerComposeFile: ["compose.yml"],
      service: "app",
      runServices: ["app", "worker"],
      mounts: ["./src:/workspace/src"],
      containerEnv: { KEEP: "yes" },
      custom: { aliases: ["app.local"] },
    };
    const result = extendDockerComposeFile(nativeConfig, ".devcontainer/network.overlay.yml");

    expect(result.status).toBe("ready");
    expect(result.config).toEqual({
      ...nativeConfig,
      dockerComposeFile: ["compose.yml", ".devcontainer/network.overlay.yml"],
    });
    expect(result.config).not.toBe(nativeConfig);
    expect(result.config?.runServices).not.toBe(nativeConfig.runServices);
    expect(nativeConfig.dockerComposeFile).toEqual(["compose.yml"]);
  });

  it("returns unknown for an invalid overlay subnet or native compose-file shape", () => {
    expect(deriveComposeNetworkOverlay("10.44.0.1/26").status).toBe("unknown");
    const result = extendDockerComposeFile({ dockerComposeFile: { invalid: true } }, "overlay.yml");
    expect(result.status).toBe("unknown");
    expect(result.reasons.map(({ code }) => code)).toContain("malformed-docker-compose-file");
  });
});

describe("Compose network fingerprint", () => {
  it("fingerprints the redacted relevant model and allocation overlay", () => {
    const first = fingerprintComposeNetworkModel({
      compose,
      authoredNetworks: { devnet: { external: true, name: "shared-devnet" } },
      demand: { helperEndpoints: 1, retainedEndpoints: 2 },
      overlay: { networks: { default: { ipam: { config: [{ subnet: "10.44.0.0/26" }] } } } },
    });
    const changedSecret = fingerprintComposeNetworkModel({
      compose: {
        ...compose,
        services: {
          ...compose.services,
          web: {
            ...compose.services.web,
            environment: { SECRET_TOKEN: "different-synthetic-secret" },
          },
        },
      },
      authoredNetworks: { devnet: { external: true, name: "shared-devnet" } },
      demand: { helperEndpoints: 1, retainedEndpoints: 2 },
      overlay: { networks: { default: { ipam: { config: [{ subnet: "10.44.0.0/26" }] } } } },
    });
    const changedOverlay = fingerprintComposeNetworkModel({
      compose,
      authoredNetworks: { devnet: { external: true, name: "shared-devnet" } },
      demand: { helperEndpoints: 1, retainedEndpoints: 2 },
      overlay: { networks: { default: { ipam: { config: [{ subnet: "10.45.0.0/26" }] } } } },
    });
    const changedBoundMetadata = fingerprintComposeNetworkModel({
      compose,
      authoredNetworks: { devnet: { external: true, name: "shared-devnet" } },
      demand: {
        helperEndpoints: 1,
        retainedEndpoints: 2,
        endpointUpperBound: {
          value: 20,
          semantics: SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS,
          secret: "synthetic-secret",
        },
      },
      overlay: { networks: { default: { ipam: { config: [{ subnet: "10.44.0.0/26" }] } } } },
    });
    const changedBoundSecret = fingerprintComposeNetworkModel({
      compose,
      authoredNetworks: { devnet: { external: true, name: "shared-devnet" } },
      demand: {
        helperEndpoints: 1,
        retainedEndpoints: 2,
        endpointUpperBound: {
          value: 20,
          semantics: SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS,
          secret: "different-synthetic-secret",
        },
      },
      overlay: { networks: { default: { ipam: { config: [{ subnet: "10.44.0.0/26" }] } } } },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(changedSecret).toBe(first);
    expect(changedBoundMetadata).not.toBe(first);
    expect(changedBoundSecret).toBe(changedBoundMetadata);
    expect(changedOverlay).not.toBe(first);
  });
});
