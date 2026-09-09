import { describe, expect, it } from "vitest";
import { qualifyNetworkProviderDefinition } from "../network-provider-inspect";

function definition(provider: "devsy" | "devpod") {
  return {
    name: "docker",
    agent: {
      local: "true",
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
describe("provider definition qualification", () => {
  it.each([
    "devsy",
    "devpod",
  ] as const)("fingerprints the scoped %s Docker binding definition", (provider) => {
    expect(qualifyNetworkProviderDefinition(definition(provider), provider)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  it("rejects redirection and competing selectors", () => {
    for (const mutate of [
      (d: ReturnType<typeof definition>) => {
        d.agent.docker.env = { ...d.agent.docker.env, DOCKER_CONTEXT: "other" } as never;
      },
      (d: ReturnType<typeof definition>) => {
        d.agent.docker.path = "/custom/docker";
      },
      (d: ReturnType<typeof definition>) => {
        d.exec.command = "other";
      },
      (d: ReturnType<typeof definition>) => {
        d.agent.local = "false";
      },
      (d: ReturnType<typeof definition>) => {
        d.agent.docker.elevation = "sudo";
      },
      (d: ReturnType<typeof definition>) => {
        d.agent.docker.install = true;
      },
    ]) {
      const d = definition("devsy");
      mutate(d);
      expect(() => qualifyNetworkProviderDefinition(d, "devsy")).toThrow();
    }
  });
});
