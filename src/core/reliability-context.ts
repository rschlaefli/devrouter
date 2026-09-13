import { assertNetworkEffectAllowed } from "./network-effect-scope";

let claim: (() => void) | undefined;

export function installLifecycleEffectClaim(callback: () => void): void {
  if (claim) throw new Error("Lifecycle worker accepts one effect authority.");
  claim = callback;
}

export function claimLifecycleEffect(): void {
  claim?.();
  assertNetworkEffectAllowed();
}
