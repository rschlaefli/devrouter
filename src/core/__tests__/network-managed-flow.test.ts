import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { ManagedDevcontainerPlan } from "../devcontainer-profile";
import {
  attachNetworkClaim,
  markNetworkClaimUncertain,
  type NetworkClaim,
  reserveNetworkClaim,
} from "../network-claims";
import { createManagedNetworkSession } from "../network-managed";
import { networkProviderStartupArguments } from "../network-provider-binding";

const state = vi.hoisted(() => ({
  root: "",
  saved: undefined as NetworkClaim | undefined,
  registration: false,
  subnet: "10.88.0.0/26",
  routes: [] as { cidr: string; interface: string }[],
  events: [] as string[],
  provider: "devsy" as "devsy" | "devpod",
  daemon: "daemon",
  policyPresent: true,
}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
vi.mock("../network-claim-lookup", () => ({
  findOwnedNetworkClaim: () => state.saved,
  networkOwnerKey: () => "owner",
}));
vi.mock("../network-policy", () => ({
  readNetworkPolicy: () =>
    state.policyPresent
      ? {
          status: "valid",
          policy: {
            version: 1,
            daemonId: "daemon",
            pools: ["10.88.0.0/24"],
            exclusions: [],
            allowedPrefixes: [24, 25, 26],
            endpointReserve: 8,
          },
        }
      : { status: "absent", path: "/synthetic-policy" },
}));
vi.mock("../network-lifecycle", () => ({
  readNetworkOperationAuthority: () => ({
    operationId: "operation",
    workerId: "worker",
    fence: { environmentId: "owner", intentRevision: 1, runtimeGeneration: 1, controllerEpoch: 1 },
  }),
  assertNetworkOperationCurrent: vi.fn(),
}));
vi.mock("../workspace-ownership", () => ({
  readWorkspaceOwnership: () => ({ worktreePath: state.root, devpodId: "synthetic" }),
}));
vi.mock("../network-provider-inspect", () => ({
  inspectNetworkProviderBinding: () => ({
    provider: state.provider,
    providerId: "synthetic",
    endpoint: "unix:///tmp/synthetic.sock",
    daemonId: state.daemon,
    providerContext: "default",
    definitionSha256: "a".repeat(64),
    versionQualified: true,
    providerName: "docker",
    dockerPath: "docker",
    persistedContext: null,
    persistedEndpoint: state.registration ? "unix:///tmp/synthetic.sock" : null,
    registration: state.registration ? "owned" : "absent",
  }),
}));
vi.mock("../network-inventory", () => ({
  collectDockerNetworkInventory: () => ({
    status: "complete",
    endpoint: "unix:///tmp/synthetic.sock",
    daemonId: state.daemon,
    pools: [],
    networks: state.registration
      ? [
          {
            id: "a".repeat(64),
            driver: "bridge",
            subnets: [state.subnet],
            composeProject: "synthetic",
            composeNetwork: "default",
            retainedContainerIds: ["b".repeat(64)],
            activeEndpoints: 1,
          },
        ]
      : [],
    reasons: [],
  }),
}));
vi.mock("../network-routes", () => ({
  collectNetworkRoutes: () => ({ status: "complete", routes: state.routes }),
}));
vi.mock("../network-connected-route", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../network-connected-route")>()),
  inspectClaimedBridge: () => "br-owned",
}));
vi.mock("../devpod-environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devpod-environment")>()),
  supportsManagedStopBaseline: () => true,
  resolveManagedStopEndpoint: () => "unix:///tmp/synthetic.sock",
  inspectManagedStopDaemon: () => state.daemon,
  inspectWorkspaceContainers: () =>
    state.registration
      ? [
          {
            id: "b".repeat(64),
            labels: {
              "com.docker.compose.project": "synthetic",
              "com.docker.compose.service": "web",
              "com.docker.compose.project.working_dir": path.join(state.root, ".devcontainer"),
              "com.docker.compose.project.config_files": [
                "compose.yml",
                "docker-compose.devrouter-network.yml",
              ]
                .map((file) => path.join(state.root, file))
                .join(","),
            },
          },
        ]
      : [],
  workspaceAppContainers: (rows: unknown[]) => rows,
}));
vi.mock("../network-compose-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../network-compose-files")>()),
  inspectNetworkComposeFiles: () => ({
    compose: {
      services: { web: { networks: { default: {}, devnet: {} } } },
      networks: {
        default: { name: "synthetic_default", driver: "bridge" },
        devnet: { name: "devnet", external: true },
      },
    },
    authoredNetworks: { devnet: { external: true } },
  }),
}));
vi.mock("../network-claims", () => ({
  reserveNetworkClaim: vi.fn((request) => {
    request.revalidate();
    state.events.push("reserved");
    state.saved = {
      ...request,
      subnet: state.subnet,
      prefix: request.prefixLength,
      state: "reserved",
    };
    return state.saved;
  }),
  attachNetworkClaim: vi.fn((request) => {
    state.saved = { ...request, state: "attached", networkId: request.attachedProof.networkId };
    return state.saved;
  }),
  markNetworkClaimUncertain: vi.fn((request) => {
    state.saved = { ...request, state: "uncertain" };
    return state.saved;
  }),
}));
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    saved: undefined,
    registration: false,
    subnet: "10.88.0.0/26",
    routes: [],
    events: [],
    daemon: "daemon",
    policyPresent: true,
    provider: "devsy",
  });
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "network-flow-"));
  roots.push(state.root);
});
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function fixture() {
  const native = {
    dockerComposeFile: ["compose.yml"],
    runServices: ["web"],
    remoteEnv: { WORKSPACE: "synthetic" },
  };
  let plan = {
    sourceConfigSha256: "source",
    composeDirectory: state.root,
    composeFiles: [path.join(state.root, "compose.yml")],
    composeServices: ["web"],
    generatedRelativePath: "devcontainer.devrouter.json",
    contents: `// devrouter:managed devcontainer profile\n${JSON.stringify(native)}\n`,
  } as ManagedDevcontainerPlan;
  const input = {
    repoPath: state.root,
    provider: state.provider,
    workspace: { token: "synthetic", gitCommonDir: "/synthetic-common" },
    hadExactProvider: state.registration,
    plan: () => plan,
    replacePlan: (next: ManagedDevcontainerPlan) => {
      state.events.push("effective-config");
      plan = next;
      fs.writeFileSync(path.join(state.root, next.generatedRelativePath), next.contents);
    },
  };
  const session = createManagedNetworkSession(input)!;
  return {
    input,
    native,
    session,
    providerStart() {
      const prepared = session.prepare("synthetic");
      prepared.beforeDispatch?.();
      const args = networkProviderStartupArguments(prepared.binding);
      expect(args).toContain("DOCKER_HOST=unix:///tmp/synthetic.sock");
      const effective = JSON.parse(
        fs
          .readFileSync(path.join(state.root, prepared.devcontainerPath), "utf8")
          .split("\n")
          .slice(1)
          .join("\n"),
      );
      const overlay = YAML.parse(
        fs.readFileSync(path.join(state.root, effective.dockerComposeFile.at(-1)), "utf8"),
      );
      expect(overlay.networks.default.ipam.config[0].subnet).toBe(state.subnet);
      expect(effective.runServices).toEqual(native.runServices);
      state.registration = true;
      return prepared;
    },
  };
}
describe("managed network preparation and recovery", () => {
  it("retains the exact network across a stopped-workspace resume without reallocating", () => {
    const first = fixture();
    first.providerStart();
    first.session.prove("synthetic", "b".repeat(64));
    expect(state.saved?.state).toBe("attached");
    const subnet = state.saved?.subnet;
    const networkId = state.saved?.networkId;
    const resumed = fixture();
    resumed.providerStart();
    resumed.session.prove("synthetic", "b".repeat(64));
    expect(state.saved).toMatchObject({ subnet, networkId, state: "attached" });
    expect(reserveNetworkClaim).toHaveBeenCalledTimes(1);
  });
  it("resumes the attached network after policy removal without selecting a new subnet", () => {
    const first = fixture();
    first.providerStart();
    first.session.prove("synthetic", "b".repeat(64));
    const retained = { subnet: state.saved?.subnet, networkId: state.saved?.networkId };
    state.policyPresent = false;
    const resumed = fixture();
    resumed.providerStart();
    resumed.session.prove("synthetic", "b".repeat(64));
    expect(state.saved).toMatchObject({ ...retained, state: "attached" });
    expect(reserveNetworkClaim).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed prefix before provider startup and preserves the claim", () => {
    const first = fixture();
    first.providerStart();
    first.session.prove("synthetic", "b".repeat(64));
    const retained = state.saved;
    const resumed = createManagedNetworkSession({
      ...first.input,
      hadExactProvider: true,
      request: { prefixLength: 25 },
    })!;
    expect(() => resumed.prepare("synthetic")).toThrow();
    expect(state.saved).toBe(retained);
    expect(reserveNetworkClaim).toHaveBeenCalledTimes(1);
  });
  it("withholds attachment when a foreign route appears after provider startup", () => {
    const f = fixture();
    f.providerStart();
    state.routes = [{ cidr: "10.88.0.0/26", interface: "tun0" }];
    expect(() => f.session.prove("synthetic", "b".repeat(64))).toThrow();
    expect(attachNetworkClaim).not.toHaveBeenCalled();
    expect(f.session.retained()).toBe(true);
    expect(state.registration).toBe(true);
  });
  it("blocks later effects on daemon replacement and preserves the attached claim", () => {
    const f = fixture();
    f.providerStart();
    f.session.prove("synthetic", "b".repeat(64));
    state.daemon = "replacement";
    expect(f.session.guard).toThrow();
    expect(state.saved?.state).toBe("attached");
  });
  it.each([
    "devsy",
    "devpod",
  ] as const)("reserves before %s consumes the generated overlay", (provider) => {
    state.provider = provider;
    const f = fixture();
    f.providerStart();
    expect(state.events).toEqual(["reserved", "effective-config"]);
    expect(reserveNetworkClaim).toHaveBeenCalledTimes(1);
  });
  it("retains a binding-only partial failure and refuses automatic retry", () => {
    const f = fixture();
    const prepared = f.providerStart();
    prepared.retainUncertain();
    expect(markNetworkClaimUncertain).toHaveBeenCalledTimes(1);
    expect(state.saved?.state).toBe("uncertain");
    expect(() =>
      createManagedNetworkSession({ ...f.input, hadExactProvider: true })!.prepare("synthetic"),
    ).toThrow();
    expect(attachNetworkClaim).not.toHaveBeenCalled();
  });
  it("blocks provider dispatch when a new conflicting route appears after reservation", () => {
    const f = fixture();
    const prepared = f.session.prepare("synthetic");
    state.routes = [{ cidr: "10.88.0.0/24", interface: "tun0" }];
    expect(prepared.beforeDispatch).toThrow();
    expect(state.registration).toBe(false);
    expect(state.saved?.state).toBe("reserved");
  });
});
