import { findOwnedNetworkClaim } from "./network-claim-lookup";
import {
  assertNetworkProviderBinding,
  networkProviderEnvironment,
} from "./network-provider-binding";
import { inspectNetworkProviderBinding } from "./network-provider-inspect";

/** Run after exact provider ownership and lifecycle fencing, under the provider lock. */
export function networkProviderEffectOptions(
  provider: "devsy" | "devpod",
  providerId: string,
  repoPath: string,
): {
  args: string[];
  env?: NodeJS.ProcessEnv;
} {
  const claim = findOwnedNetworkClaim(repoPath);
  if (!claim) return { args: [] };
  if (claim.provider !== provider || claim.providerId !== providerId)
    throw new Error("Provider differs from retained network owner; repair is required.");
  assertNetworkProviderBinding(
    claim,
    inspectNetworkProviderBinding({
      provider,
      providerId,
      repoPath,
      endpoint: claim.endpoint,
      providerContext: claim.providerContext,
    }),
    false,
  );
  return {
    args: ["--context", claim.providerContext, "--provider", "docker"],
    env: networkProviderEnvironment(claim, process.env),
  };
}
