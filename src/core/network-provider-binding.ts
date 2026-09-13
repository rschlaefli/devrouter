import { supportsManagedStopBaseline } from "./devpod-environment";

export type NetworkProviderBinding = {
  provider: "devpod" | "devsy";
  providerId: string;
  endpoint: string;
  daemonId: string;
  definitionSha256: string;
  providerContext: string;
};

export type NetworkProviderBindingEvidence = {
  provider: "devpod" | "devsy";
  providerId: string;
  versionQualified: boolean;
  definitionSha256: string;
  providerName: string;
  dockerPath: string;
  endpoint: string;
  daemonId: string;
  persistedEndpoint: string | null;
  persistedContext: string | null;
  registration: "absent" | "owned" | "conflict" | "unknown";
  providerContext: string;
};

export type PreparedNetworkStart = {
  binding: NetworkProviderBinding;
  evidence: NetworkProviderBindingEvidence;
  firstAllocation: boolean;
  devcontainerPath: string;
  retainUncertain: () => void;
  beforeDispatch?: () => void;
};
export type PrepareNetworkStart = (providerId: string) => PreparedNetworkStart;

/** Called with fresh evidence under the existing exact-provider ownership lock. */
export function assertNetworkProviderBinding(
  binding: NetworkProviderBinding,
  evidence: NetworkProviderBindingEvidence,
  firstAllocation: boolean,
): void {
  if (
    !binding.providerId ||
    !binding.daemonId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(binding.providerContext) ||
    evidence.providerContext !== binding.providerContext ||
    !supportsManagedStopBaseline(binding.endpoint) ||
    !/^[a-f0-9]{64}$/.test(binding.definitionSha256) ||
    !evidence.versionQualified ||
    evidence.providerName !== "docker" ||
    evidence.dockerPath !== "docker" ||
    evidence.provider !== binding.provider ||
    evidence.providerId !== binding.providerId ||
    evidence.endpoint !== binding.endpoint ||
    evidence.daemonId !== binding.daemonId ||
    evidence.definitionSha256 !== binding.definitionSha256 ||
    evidence.persistedContext !== null
  )
    throw new Error("Network provider destination is unqualified or changed; repair is required.");
  if (firstAllocation) {
    if (evidence.registration !== "absent" || evidence.persistedEndpoint !== null)
      throw new Error("Network allocation requires an exact new provider identity.");
  } else if (evidence.registration !== "owned" || evidence.persistedEndpoint !== binding.endpoint) {
    throw new Error("Retained network provider binding is missing or changed; repair is required.");
  }
}

export function networkProviderStartupArguments(binding: NetworkProviderBinding): string[] {
  if (!supportsManagedStopBaseline(binding.endpoint))
    throw new Error("Network provider requires an exact local Docker endpoint.");
  return [
    "--context",
    binding.providerContext,
    "--provider",
    "docker",
    "--provider-option",
    `DOCKER_HOST=${binding.endpoint}`,
  ];
}

export function networkProviderEnvironment(
  binding: NetworkProviderBinding,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!supportsManagedStopBaseline(binding.endpoint))
    throw new Error("Network provider requires an exact local Docker endpoint.");
  const env = { ...source };
  // The qualified provider supplies DOCKER_HOST; ambient context has higher
  // Docker CLI precedence and must not redirect the saved workspace binding.
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  return env;
}
