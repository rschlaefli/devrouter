import { describe, expect, it } from "vitest";
import {
  assertNetworkProviderBinding,
  type NetworkProviderBinding,
  type NetworkProviderBindingEvidence,
  networkProviderEnvironment,
  networkProviderStartupArguments,
} from "../network-provider-binding";

const binding: NetworkProviderBinding = {
  provider: "devsy",
  providerId: "synthetic",
  endpoint: "unix:///tmp/synthetic.sock",
  daemonId: "daemon",
  definitionSha256: "a".repeat(64),
  providerContext: "default",
};
function evidence(): NetworkProviderBindingEvidence {
  return {
    ...binding,
    versionQualified: true,
    providerName: "docker",
    dockerPath: "docker",
    persistedEndpoint: null,
    persistedContext: null,
    registration: "absent",
  };
}
describe("exact workspace provider endpoint binding", () => {
  it.each([
    "devsy",
    "devpod",
  ] as const)("binds %s without shared configuration commands", (provider) => {
    const target = { ...binding, provider };
    expect(() =>
      assertNetworkProviderBinding(target, { ...evidence(), provider }, true),
    ).not.toThrow();
    expect(networkProviderStartupArguments(target)).toEqual([
      "--context",
      "default",
      "--provider",
      "docker",
      "--provider-option",
      "DOCKER_HOST=unix:///tmp/synthetic.sock",
    ]);
    const source = {
      DOCKER_CONTEXT: "other",
      DOCKER_HOST: "unix:///other.sock",
      WORKSPACE: "synthetic",
    };
    expect(networkProviderEnvironment(target, source)).toEqual({ WORKSPACE: "synthetic" });
    expect(source.DOCKER_CONTEXT).toBe("other");
  });
  it("requires unchanged identity and binding for resume", () => {
    const current = {
      ...evidence(),
      registration: "owned" as const,
      persistedEndpoint: binding.endpoint,
    };
    expect(() => assertNetworkProviderBinding(binding, current, false)).not.toThrow();
    for (const drift of [
      { daemonId: "replacement" },
      { persistedEndpoint: null },
      { registration: "absent" },
      { definitionSha256: "b".repeat(64) },
      { persistedContext: "other" },
      { dockerPath: "/custom/docker" },
      { versionQualified: false },
    ]) {
      expect(() =>
        assertNetworkProviderBinding(
          binding,
          { ...current, ...drift } as NetworkProviderBindingEvidence,
          false,
        ),
      ).toThrow();
    }
    expect(() => assertNetworkProviderBinding(binding, current, true)).toThrow();
  });
});
