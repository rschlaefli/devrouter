import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevcontainerPlan } from "../devcontainer-profile";
import type { WorkspaceContainerSnapshot } from "../devpod-environment";
import {
  buildHostEnvReport,
  collectHostEnvReport,
  type HostEnvEvidence,
  hostEnvVariables,
  parseLoopbackBinding,
} from "../host-env";
import { managedHostPortDeclarationsIdentity } from "../managed-host-ports";
import type { ManagedRuntimeState } from "../managed-runtime-state";
import { applyWorkspace, loadRepoConfig } from "../repo-config";

const runtime = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  readManagedRuntimeState: vi.fn(),
  inspectManagedDevcontainerConfig: vi.fn(),
  resolveManagedHostPorts: vi.fn(),
  findOwnedNetworkClaim: vi.fn(),
  prepareNetworkComposeFiles: vi.fn(),
  listHostRoutes: vi.fn(),
  listContainers: vi.fn(),
  isTLSEnabled: vi.fn(),
  getMkcertRootCAPath: vi.fn(),
}));

vi.mock("../workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspace")>()),
  resolveWorkspace: runtime.resolveWorkspace,
}));
vi.mock("../managed-runtime-state", () => ({
  readManagedRuntimeState: runtime.readManagedRuntimeState,
}));
vi.mock("../devcontainer-profile", () => ({
  inspectManagedDevcontainerConfig: runtime.inspectManagedDevcontainerConfig,
}));
vi.mock("../network-claim-lookup", () => ({
  findOwnedNetworkClaim: runtime.findOwnedNetworkClaim,
}));
vi.mock("../network-compose-files", () => ({
  prepareNetworkComposeFiles: runtime.prepareNetworkComposeFiles,
}));
vi.mock("../managed-host-ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-host-ports")>()),
  resolveManagedHostPorts: runtime.resolveManagedHostPorts,
}));
vi.mock("../host-routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../host-routes")>()),
  listHostRoutes: runtime.listHostRoutes,
}));
vi.mock("../docker", () => ({ listContainers: runtime.listContainers }));
vi.mock("../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../router")>()),
  isTLSEnabled: runtime.isTLSEnabled,
}));
vi.mock("../tls", () => ({ getMkcertRootCAPath: runtime.getMkcertRootCAPath }));

const CONFIG_YAML = `version: 1
project:
  name: shop
apps:
  - name: web
    host: web.shop.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-app:3000
  - name: db
    host: db.shop.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: proxy
    upstream: \${WORKSPACE}-db:5432
`;

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "host-env-"));
fs.writeFileSync(path.join(REPO, ".devrouter.yml"), CONFIG_YAML);

const PORT_CONFIG_YAML = `version: 1
project:
  name: shop
managedRuntime:
  devcontainer:
    baseServices: [blob]
    profileServices: [mail]
    hostPorts:
      blob:
        service: blob
        target: 10000
      mail:
        service: mail
        target: 1025
  processes: [worker]
apps:
  - name: web
    host: web.shop.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-app:3000
`;

const PORT_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "host-env-ports-"));
fs.writeFileSync(path.join(PORT_REPO, ".devrouter.yml"), PORT_CONFIG_YAML);

const CONFIG_HASH = "a".repeat(64);
const COMPOSE_FILES = [path.join(PORT_REPO, ".devcontainer", "docker-compose.yml")];

function config(workspace: string | undefined) {
  return applyWorkspace(loadRepoConfig(REPO), workspace, REPO);
}

function portConfig(workspace: string | undefined) {
  return applyWorkspace(loadRepoConfig(PORT_REPO), workspace, PORT_REPO);
}

function retainedState(): ManagedRuntimeState {
  return {
    version: 1,
    hostPortDeclarationsSha256: managedHostPortDeclarationsIdentity(
      portConfig("feature").managedRuntime!.devcontainer.hostPorts!,
    ),
    repoPath: PORT_REPO,
    workspace: "feature",
    devpodId: "ports-devpod",
    composeProject: "shop-ports",
    profile: "default",
    desired: { apps: ["web"], services: ["mail"], processes: ["worker"] },
    sourceConfigSha256: CONFIG_HASH,
    effectiveConfigSha256: CONFIG_HASH,
    status: "ready",
    updatedAt: new Date(0).toISOString(),
  };
}

function managedPlan(): ManagedDevcontainerPlan {
  return {
    sourcePath: path.join(PORT_REPO, ".devcontainer", "devcontainer.json"),
    generatedPath: path.join(PORT_REPO, ".devcontainer", "devcontainer.devrouter.json"),
    generatedRelativePath: ".devcontainer/devcontainer.devrouter.json",
    sourceConfigSha256: CONFIG_HASH,
    effectiveConfigSha256: CONFIG_HASH,
    primaryService: "app",
    composeDirectory: path.join(PORT_REPO, ".devcontainer"),
    composeFiles: COMPOSE_FILES,
    composeServices: ["app", "blob", "mail"],
    nativeRunServices: ["app", "blob", "mail"],
    baseServices: ["blob"],
    profileServices: ["mail"],
    desiredProfileServices: ["mail"],
    desiredServices: ["app", "blob", "mail"],
    contents: "",
  };
}

function container(
  id: string,
  options: { workingDir?: string; aliases?: string[]; running?: boolean } = {},
): WorkspaceContainerSnapshot {
  return {
    id,
    state: { Running: options.running ?? true },
    labels: {
      "com.docker.compose.project.working_dir": options.workingDir ?? `${REPO}/.devcontainer`,
    },
    mounts: [],
    networks: { devnet: { Aliases: options.aliases ?? [] } },
  };
}

function evidence(overrides: Partial<HostEnvEvidence> = {}): HostEnvEvidence {
  return {
    tlsEnabled: true,
    activeHosts: new Set(),
    caPath: "/synthetic/ca/rootCA.pem",
    containers: [],
    publishedBindings: () => "",
    ...overrides,
  };
}

function dbApp(report: ReturnType<typeof buildHostEnvReport>) {
  const app = report.apps.find((entry) => entry.name === "db");
  if (app?.protocol !== "tcp") throw new Error("db app missing");
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.resolveWorkspace.mockReturnValue("feature");
  runtime.readManagedRuntimeState.mockReturnValue(retainedState());
  runtime.inspectManagedDevcontainerConfig.mockReturnValue(managedPlan());
  runtime.resolveManagedHostPorts.mockReturnValue({});
  runtime.findOwnedNetworkClaim.mockReturnValue(undefined);
  runtime.listHostRoutes.mockReturnValue([]);
  runtime.listContainers.mockResolvedValue([]);
  runtime.isTLSEnabled.mockReturnValue(true);
  runtime.getMkcertRootCAPath.mockReturnValue("/synthetic/ca/rootCA.pem");
});

describe("buildHostEnvReport", () => {
  it("reports namespaced URLs and both TCP endpoints for a linked worktree", () => {
    const report = buildHostEnvReport({
      repoPath: REPO,
      config: config("feature"),
      workspace: "feature",
      evidence: evidence({
        activeHosts: new Set(["web.shop.feature.localhost"]),
        containers: [container("db-1", { aliases: ["feature-db"] })],
        publishedBindings: (id, port) =>
          id === "db-1" && port === 5432 ? "0.0.0.0:6000\n127.0.0.1:49153\n" : "",
      }),
    });

    expect(report).toMatchObject({
      version: 1,
      workspace: "feature",
      caPath: "/synthetic/ca/rootCA.pem",
    });
    expect(report).not.toHaveProperty("hostPorts");
    expect(report.apps[0]).toEqual({
      name: "web",
      protocol: "http",
      host: "web.shop.feature.localhost",
      active: true,
      url: "https://web.shop.feature.localhost",
    });
    expect(dbApp(report)).toMatchObject({
      active: false,
      routed: {
        host: "db.shop.feature.localhost",
        port: 5432,
        params: { sslmode: "require", sslnegotiation: "direct" },
      },
      loopback: { host: "127.0.0.1", port: 49153 },
    });
  });

  it("refuses to attribute a loopback port it cannot prove belongs to this checkout", () => {
    const resolve = (
      containers: WorkspaceContainerSnapshot[] | undefined,
      bindings = "127.0.0.1:1",
    ) =>
      dbApp(
        buildHostEnvReport({
          repoPath: REPO,
          config: config("feature"),
          workspace: "feature",
          evidence: evidence({ containers, publishedBindings: () => bindings }),
        }),
      );

    const foreign = container("other", {
      aliases: ["feature-db"],
      workingDir: path.join(path.dirname(REPO), "other", ".devcontainer"),
    });
    expect(resolve([foreign])).toMatchObject({ loopback: null, loopbackReason: "not-found" });
    expect(
      resolve([
        container("a", { aliases: ["feature-db"] }),
        container("b", { aliases: ["feature-db"] }),
      ]),
    ).toMatchObject({ loopback: null, loopbackReason: "ambiguous" });
    expect(resolve([container("a", { aliases: ["feature-db"], running: false })])).toMatchObject({
      loopback: null,
      loopbackReason: "not-running",
    });
    expect(resolve([container("a", { aliases: ["feature-db"] })], "0.0.0.0:6000")).toMatchObject({
      loopback: null,
      loopbackReason: "not-published",
    });
    expect(resolve(undefined)).toMatchObject({ loopback: null, loopbackReason: "unavailable" });
  });

  it("keeps the report usable when the CA is missing", () => {
    const report = buildHostEnvReport({
      repoPath: REPO,
      config: config(undefined),
      workspace: undefined,
      evidence: evidence({ caPath: { error: "mkcert missing" }, tlsEnabled: false }),
    });
    expect(report).toMatchObject({ workspace: null, caPath: null, caReason: "mkcert missing" });
    expect(report.apps[0]).toMatchObject({ url: "http://web.shop.localhost" });
  });
});

describe("managed host ports", () => {
  it("uses retained selections and current exact proof for fresh port maps", async () => {
    runtime.resolveManagedHostPorts
      .mockReturnValueOnce({
        blob: {
          service: "blob",
          target: 10000,
          status: "available",
          endpoint: { host: "127.0.0.1", port: 49153 },
        },
        mail: {
          service: "mail",
          target: 1025,
          status: "available",
          endpoint: { host: "127.0.0.1", port: 25125 },
        },
      })
      .mockReturnValueOnce({
        blob: {
          service: "blob",
          target: 10000,
          status: "available",
          endpoint: { host: "127.0.0.1", port: 52001 },
        },
        mail: {
          service: "mail",
          target: 1025,
          status: "available",
          endpoint: { host: "127.0.0.1", port: 25126 },
        },
      });

    const first = await collectHostEnvReport(PORT_REPO);
    const second = await collectHostEnvReport(PORT_REPO);

    expect(hostEnvVariables(first, {})).toMatchObject({
      DEVROUTER_HOST_PORT_BLOB: "49153",
      DEVROUTER_HOST_PORT_MAIL: "25125",
    });
    expect(hostEnvVariables(second, {})).toMatchObject({
      DEVROUTER_HOST_PORT_BLOB: "52001",
      DEVROUTER_HOST_PORT_MAIL: "25126",
    });
    expect(runtime.readManagedRuntimeState).toHaveBeenCalledWith(PORT_REPO, "feature");
    expect(runtime.inspectManagedDevcontainerConfig).toHaveBeenCalledWith({
      repoPath: PORT_REPO,
      config: portConfig("feature"),
      profile: {
        apps: ["web"],
        devcontainerServices: ["mail"],
        processes: ["worker"],
      },
      linked: true,
    });
    expect(runtime.resolveManagedHostPorts).toHaveBeenCalledWith({
      repoPath: PORT_REPO,
      declarations: portConfig("feature").managedRuntime?.devcontainer.hostPorts,
      selectedServices: ["blob", "mail"],
      composeProject: "shop-ports",
      composeFiles: COMPOSE_FILES,
    });
  });

  it("reconstructs the retained network plan without writing it", async () => {
    const effective = {
      ...managedPlan(),
      effectiveConfigSha256: "b".repeat(64),
      composeFiles: [
        ...COMPOSE_FILES,
        `${PORT_REPO}/.devcontainer/docker-compose.devrouter-network.yml`,
      ],
    };
    runtime.readManagedRuntimeState.mockReturnValue({
      ...retainedState(),
      effectiveConfigSha256: "b".repeat(64),
    });
    runtime.findOwnedNetworkClaim.mockReturnValue({ state: "attached", subnet: "172.30.0.0/26" });
    const write = vi.fn();
    runtime.prepareNetworkComposeFiles.mockReturnValue({ plan: effective, write });
    await collectHostEnvReport(PORT_REPO);
    expect(runtime.resolveManagedHostPorts).toHaveBeenCalledWith(
      expect.objectContaining({ composeFiles: effective.composeFiles }),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses host-port export after declarations change without ensure", async () => {
    runtime.readManagedRuntimeState.mockReturnValue({
      ...retainedState(),
      hostPortDeclarationsSha256: undefined,
    });
    const report = await collectHostEnvReport(PORT_REPO);
    expect(report.hostPorts?.blob.status).toBe("unavailable");
    expect(runtime.resolveManagedHostPorts).not.toHaveBeenCalled();
  });

  it("reports selected declarations unavailable when no retained state exists", async () => {
    runtime.readManagedRuntimeState.mockReturnValue(undefined);

    const report = await collectHostEnvReport(PORT_REPO);

    expect(report.hostPorts).toEqual({
      blob: { service: "blob", target: 10000, status: "unavailable", reason: "unavailable" },
      mail: { service: "mail", target: 1025, status: "unavailable", reason: "unavailable" },
    });
    expect(runtime.inspectManagedDevcontainerConfig).not.toHaveBeenCalled();
    expect(runtime.resolveManagedHostPorts).not.toHaveBeenCalled();
  });

  it.each([
    "sourceConfigSha256",
    "effectiveConfigSha256",
  ] as const)("keeps the report usable when the retained %s is stale", async (field) => {
    runtime.inspectManagedDevcontainerConfig.mockReturnValue({
      ...managedPlan(),
      [field]: "b".repeat(64),
    });

    const report = await collectHostEnvReport(PORT_REPO);

    expect(report.apps).toHaveLength(1);
    expect(report.hostPorts?.blob).toEqual({
      service: "blob",
      target: 10000,
      status: "unavailable",
      reason: "unavailable",
    });
    expect(runtime.resolveManagedHostPorts).not.toHaveBeenCalled();
  });
});

describe("parseLoopbackBinding", () => {
  it("accepts IPv6 loopback and ignores wildcard bindings", () => {
    expect(parseLoopbackBinding("[::1]:49200\n")).toEqual({ host: "::1", port: 49200 });
    expect(parseLoopbackBinding("0.0.0.0:49200\n[::]:49200\n")).toBeUndefined();
  });
});
