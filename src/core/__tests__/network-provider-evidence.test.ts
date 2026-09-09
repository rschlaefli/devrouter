import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectManagedStopDaemon } from "../devpod-environment";
import { inspectNetworkProviderBinding } from "../network-provider-inspect";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../devpod-environment", () => ({ inspectManagedStopDaemon: vi.fn(() => "daemon") }));
const endpoint = "unix:///tmp/synthetic.sock";
let saved: Record<string, unknown>;
let contexts: unknown;
let fail = false;
function providerDefinition(provider: string) {
  return {
    name: "docker",
    agent: {
      local: true,
      docker: {
        path: "${DOCKER_PATH}",
        builder: "${DOCKER_BUILDER}",
        install: false,
        ...(provider === "devsy" ? { elevation: "${DOCKER_ELEVATION}" } : {}),
        env: { DOCKER_HOST: "${DOCKER_HOST}" },
      },
    },
    options: { DOCKER_HOST: { global: true }, DOCKER_PATH: { default: "docker" } },
    exec: {
      command:
        provider === "devsy"
          ? '"${DEVSY}" internal sh -c "${COMMAND}"'
          : '"${DEVPOD}" helper sh -c "${COMMAND}"',
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  saved = { DOCKER_HOST: { value: endpoint } };
  contexts = [{ name: "synthetic-context", default: true }];
  fail = false;
  vi.mocked(spawnSync).mockImplementation(((provider: string, args: string[]) => {
    if (fail) return { status: 1, stdout: "synthetic-private-marker" };
    let value: unknown;
    if (args[0] === "--version" || args[0] === "version")
      return { status: 0, stdout: provider === "devsy" ? "v1.16.2" : "v0.6.15" };
    if (args[0] === "context") value = contexts;
    else {
      expect(args).toContain("synthetic-context");
      value =
        args[0] === "provider"
          ? {
              docker: {
                config: providerDefinition(provider),
                state: { options: { DOCKER_HOST: { value: endpoint } } },
              },
            }
          : [
              {
                id: "synthetic",
                source: { localFolder: "/synthetic" },
                provider: { name: "docker", options: saved },
              },
            ];
    }
    return { status: 0, stdout: JSON.stringify(value) };
  }) as never);
});
describe("provider binding evidence collection", () => {
  it.each([
    "devsy",
    "devpod",
  ] as const)("pins %s reads and distinguishes saved from shared options", (provider) => {
    const input = { provider, providerId: "synthetic", repoPath: "/synthetic", endpoint };
    expect(inspectNetworkProviderBinding(input)).toMatchObject({
      persistedEndpoint: endpoint,
      providerContext: "synthetic-context",
      registration: "owned",
    });
    saved = {};
    expect(inspectNetworkProviderBinding(input).persistedEndpoint).toBeNull();
    expect(inspectManagedStopDaemon).toHaveBeenCalledWith(endpoint);
  });
  it("rejects missing context and suppresses raw failed output", () => {
    const input = {
      provider: "devsy" as const,
      providerId: "synthetic",
      repoPath: "/synthetic",
      endpoint,
    };
    contexts = [];
    expect(() => inspectNetworkProviderBinding(input)).toThrow();
    fail = true;
    try {
      inspectNetworkProviderBinding(input);
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-private-marker");
    }
  });
});
