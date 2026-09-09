import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomically } from "../atomic-file";
import {
  attachNetworkClaim,
  markNetworkClaimUncertain,
  type NetworkClaim,
  type NetworkClaimCapacitySnapshot,
  type NetworkClaimReleaseProof,
  type NetworkClaimReservationRequest,
  networkClaimsPath,
  readNetworkClaims,
  releaseNetworkClaim,
  reserveNetworkClaim,
} from "../network-claims";

const temporaryRoots: string[] = [];
const identity = {
  providerId: "provider-a",
  provider: "devpod" as const,
  providerContext: "context-a",
  definitionSha256: "a".repeat(64),
  endpoint: "unix:///var/run/docker.sock",
  daemonId: "daemon-a",
  configFingerprint: "config-a",
};
const fence = {
  environmentId: "environment-a",
  intentRevision: 1,
  runtimeGeneration: 1,
  controllerEpoch: 1,
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-network-claims-"));
  temporaryRoots.push(value);
  return value;
}

function snapshot(
  overrides: {
    policy?: Partial<NetworkClaimCapacitySnapshot["policy"]>;
    inventory?: Partial<NetworkClaimCapacitySnapshot["inventory"]>;
    routes?: NetworkClaimCapacitySnapshot["routes"];
    endpointDemand?: number | null;
  } = {},
): NetworkClaimCapacitySnapshot {
  const daemonId = overrides.policy?.daemonId ?? identity.daemonId;
  return {
    policy: {
      version: 1,
      daemonId,
      pools: ["10.88.0.0/24"],
      exclusions: [],
      allowedPrefixes: [26],
      endpointReserve: 8,
      ...overrides.policy,
    },
    inventory: {
      endpoint: identity.endpoint,
      daemonId,
      status: "complete",
      pools: [{ base: "10.88.0.0/24", size: 24 }],
      networks: [],
      reasons: [],
      ...overrides.inventory,
    },
    routes: overrides.routes ?? { status: "complete", routes: [] },
    endpointDemand: overrides.endpointDemand,
  };
}

function request(
  ownerKey = "owner-a",
  overrides: Partial<NetworkClaimReservationRequest> = {},
): NetworkClaimReservationRequest {
  const current = snapshot();
  return {
    ...identity,
    ownerKey,
    operationId: `operation-${ownerKey}`,
    workerId: `worker-${ownerKey}`,
    fence,
    revalidate: () => current,
    ...overrides,
  };
}

function expected(claim: NetworkClaim, state?: NetworkClaim["state"]) {
  return {
    operationId: claim.operationId,
    workerId: claim.workerId,
    fence: claim.fence,
    ...(state ? { state } : {}),
  };
}

function claimIdentity(claim: NetworkClaim) {
  return {
    ownerKey: claim.ownerKey,
    providerId: claim.providerId,
    provider: claim.provider,
    providerContext: claim.providerContext,
    definitionSha256: claim.definitionSha256,
    endpoint: claim.endpoint,
    daemonId: claim.daemonId,
    configFingerprint: claim.configFingerprint,
  };
}

function attachedProof(claim: NetworkClaim, networkId = "network-a") {
  return {
    networkId,
    endpoint: claim.endpoint,
    daemonId: claim.daemonId,
    subnet: claim.subnet,
  };
}

function releaseProof(
  overrides: Partial<NetworkClaimReleaseProof["effects"]> = {},
): NetworkClaimReleaseProof {
  return {
    terminalWorkerSettled: true,
    noFutureEffects: true,
    effects: {
      binding: "absent",
      registration: "absent",
      containers: "absent",
      network: "absent",
      ...overrides,
    },
  };
}

function runRace(
  rootPath: string,
  ownerKey: string,
  providerId: string,
  provider: "devpod" | "devsy",
) {
  const fixture = path.join(__dirname, "fixtures", "network-claim-race.ts");
  const input = JSON.stringify({
    root: rootPath,
    ownerKey,
    ...identity,
    providerId,
    provider,
    operationId: `operation-${ownerKey}`,
    workerId: `worker-${ownerKey}`,
    fence,
  });
  const child = spawn(process.execPath, ["--import", "tsx", fixture, input], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("network claim allocation", () => {
  it("revalidates under the daemon lock and allocates the first aligned block", () => {
    const rootPath = root();
    let revalidationCalls = 0;
    const current = snapshot({ policy: { exclusions: ["10.88.0.0/26"] } });
    const claim = reserveNetworkClaim(
      request("owner-a", {
        revalidate: () => {
          revalidationCalls += 1;
          return current;
        },
      }),
      { root: rootPath },
    );

    expect(revalidationCalls).toBe(1);
    expect(claim).toMatchObject({ state: "reserved", subnet: "10.88.0.64/26", prefix: 26 });
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })).toEqual([claim]);
    expect(networkClaimsPath(identity.daemonId, rootPath)).not.toContain("owner-a");
  });

  it("serializes provider claims and never carves an occupied /24", () => {
    const rootPath = root();
    const first = reserveNetworkClaim(request("owner-a"), { root: rootPath });
    const second = reserveNetworkClaim(
      request("owner-b", {
        providerId: "provider-b",
        provider: "devsy",
      }),
      { root: rootPath },
    );
    expect([first.subnet, second.subnet]).toEqual(["10.88.0.0/26", "10.88.0.64/26"]);

    const occupiedRoot = root();
    const occupied = snapshot({
      inventory: {
        networks: [
          {
            id: "network-existing",
            name: "existing",
            driver: "bridge",
            subnets: ["10.88.0.0/24"],
            activeEndpoints: 0,
            retainedContainerIds: [],
          },
        ],
      },
    });
    expect(() =>
      reserveNetworkClaim(request("owner-c", { revalidate: () => occupied }), {
        root: occupiedRoot,
      }),
    ).toThrowError(expect.objectContaining({ code: "capacity-exhausted" }));
  });

  it("blocks unknown route evidence and full capacity before persistence", () => {
    const unknownRoot = root();
    const unknown = snapshot({ routes: { status: "unknown", routes: [] } });
    expect(() =>
      reserveNetworkClaim(request("owner-unknown", { revalidate: () => unknown }), {
        root: unknownRoot,
      }),
    ).toThrowError(expect.objectContaining({ code: "capacity-unknown" }));
    expect(readNetworkClaims({ root: unknownRoot, daemonId: identity.daemonId })).toEqual([]);
  });

  it("requires the exact operation fence and network proof for attachment and reuse", () => {
    const rootPath = root();
    const claim = reserveNetworkClaim(request(), { root: rootPath });
    const attached = attachNetworkClaim(
      {
        ...claimIdentity(claim),
        expected: expected(claim, "reserved"),
        attachedProof: attachedProof(claim),
      },
      { root: rootPath },
    );
    expect(attached).toMatchObject({ state: "attached", networkId: "network-a" });

    expect(() =>
      markNetworkClaimUncertain(
        {
          ...claimIdentity(claim),
          expected: expected(claim, "reserved"),
        },
        { root: rootPath },
      ),
    ).toThrowError(expect.objectContaining({ code: "compare-and-swap-failed" }));

    const reused = reserveNetworkClaim(
      request("owner-a", {
        operationId: "operation-resume",
        workerId: "worker-resume",
        fence: { ...fence, runtimeGeneration: 2 },
        subnet: attached.subnet,
        attachedProof: attachedProof(attached),
        revalidate: () => {
          throw new Error("policy is absent during exact attached reuse");
        },
      }),
      { root: rootPath },
    );
    expect(reused).toEqual(attached);

    expect(() =>
      reserveNetworkClaim(
        request("owner-a", { configFingerprint: "changed", subnet: attached.subnet }),
        { root: rootPath },
      ),
    ).toThrowError(expect.objectContaining({ code: "repair-required" }));
    expect(() =>
      reserveNetworkClaim(
        request("owner-a", { definitionSha256: "b".repeat(64), subnet: attached.subnet }),
        { root: rootPath },
      ),
    ).toThrowError(expect.objectContaining({ code: "repair-required" }));
    expect(() =>
      reserveNetworkClaim(
        request("owner-a", { providerContext: "other-context", subnet: attached.subnet }),
        { root: rootPath },
      ),
    ).toThrowError(expect.objectContaining({ code: "repair-required" }));
  });

  it("retains uncertain claims and denies release for retained or unknown effects", () => {
    const rootPath = root();
    const claim = reserveNetworkClaim(request(), { root: rootPath });
    const uncertain = markNetworkClaimUncertain(
      {
        ...claimIdentity(claim),
        expected: expected(claim, "reserved"),
      },
      { root: rootPath },
    );
    expect(uncertain.state).toBe("uncertain");
    expect(
      releaseNetworkClaim(
        {
          ...claimIdentity(uncertain),
          expected: expected(uncertain, "uncertain"),
          proof: releaseProof({ binding: "unknown" }),
        },
        { root: rootPath },
      ),
    ).toBe(false);
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })).toEqual([uncertain]);

    expect(
      releaseNetworkClaim(
        {
          ...claimIdentity(uncertain),
          expected: expected(uncertain, "uncertain"),
          proof: releaseProof(),
        },
        { root: rootPath },
      ),
    ).toBe(true);
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })).toEqual([]);
  });

  it("does not acknowledge a reservation when atomic persistence fails", () => {
    const rootPath = root();
    let writes = 0;
    expect(() =>
      reserveNetworkClaim(request(), {
        root: rootPath,
        writeAtomic: (filePath, contents) => {
          writes += 1;
          writeFileAtomically(filePath, contents);
          if (writes === 1) throw new Error("synthetic fsync failure");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-state" }));
    expect(writes).toBe(2);
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })).toHaveLength(1);
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })[0]?.state).toBe(
      "uncertain",
    );
  });

  it("rejects stale operation generations during compare-and-swap", () => {
    const rootPath = root();
    const claim = reserveNetworkClaim(request(), { root: rootPath });
    expect(() =>
      markNetworkClaimUncertain(
        {
          ...claimIdentity(claim),
          expected: {
            ...expected(claim, "reserved"),
            fence: { ...claim.fence, runtimeGeneration: claim.fence.runtimeGeneration + 1 },
          },
        },
        { root: rootPath },
      ),
    ).toThrowError(expect.objectContaining({ code: "compare-and-swap-failed" }));
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })).toEqual([claim]);
  });

  it("loses the second process in a last-block race across providers", async () => {
    const rootPath = root();
    const [first, second] = await Promise.all([
      runRace(rootPath, "race-owner-a", "race-provider-a", "devpod"),
      runRace(rootPath, "race-owner-b", "race-provider-b", "devsy"),
    ]);
    expect([first.code, second.code].filter((code) => code === 0)).toHaveLength(1);
    expect([first.code, second.code].filter((code) => code !== 0)).toHaveLength(1);
    expect(readNetworkClaims({ root: rootPath, daemonId: identity.daemonId })).toHaveLength(1);
    expect(`${first.stderr}${second.stderr}`).not.toContain("/Users/");
  }, 15_000);
});
