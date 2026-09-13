import { type NetworkClaimCapacitySnapshot, reserveNetworkClaim } from "../../network-claims";
import type { ReliabilityFence } from "../../reliability-contract";

type RaceInput = {
  root: string;
  ownerKey: string;
  providerId: string;
  provider: "devpod" | "devsy";
  providerContext: string;
  definitionSha256: string;
  endpoint: string;
  daemonId: string;
  configFingerprint: string;
  operationId: string;
  workerId: string;
  fence: ReliabilityFence;
};

const input = JSON.parse(process.argv[2] ?? "null") as RaceInput;
const snapshot: NetworkClaimCapacitySnapshot = {
  policy: {
    version: 1,
    daemonId: input.daemonId,
    pools: ["10.88.0.0/26"],
    exclusions: [],
    allowedPrefixes: [26],
    endpointReserve: 8,
  },
  inventory: {
    endpoint: input.endpoint,
    daemonId: input.daemonId,
    status: "complete",
    pools: [{ base: "10.88.0.0/26", size: 26 }],
    networks: [],
    reasons: [],
  },
  routes: { status: "complete", routes: [] },
};

try {
  const claim = reserveNetworkClaim(
    {
      ownerKey: input.ownerKey,
      providerId: input.providerId,
      provider: input.provider,
      providerContext: input.providerContext,
      definitionSha256: input.definitionSha256,
      endpoint: input.endpoint,
      daemonId: input.daemonId,
      configFingerprint: input.configFingerprint,
      operationId: input.operationId,
      workerId: input.workerId,
      fence: input.fence,
      revalidate: () => snapshot,
    },
    { root: input.root },
  );
  process.stdout.write(`${claim.subnet}\n`);
} catch {
  process.exitCode = 1;
}
