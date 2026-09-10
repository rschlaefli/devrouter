import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectHostPortClaimConflicts,
  hostPortBindingsConflict,
  resolveFixedPublishedHostPorts,
} from "../host-port-claims";
import { listWorkspaceOwnership } from "../workspace-ownership";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../workspace-ownership", () => ({ listWorkspaceOwnership: vi.fn(() => []) }));

beforeEach(() => {
  vi.clearAllMocks();
});

const REPO = "/tmp/host-port-claims-test/repo";
const DEVCONTAINER_DIR = `${REPO}/.devcontainer`;
const FOREIGN_DIR = "/tmp/host-port-claims-test/other/.devcontainer";
const PLAN = {
  composeDirectory: DEVCONTAINER_DIR,
  composeFiles: [
    `${DEVCONTAINER_DIR}/docker-compose.yml`,
    `${DEVCONTAINER_DIR}/docker-compose.devrouter.yml`,
  ],
};

function dockerResult(stdout: string): never {
  return { status: 0, stdout, stderr: "" } as never;
}

function renderedModel(services: Record<string, unknown>): never {
  return dockerResult(`${JSON.stringify({ services })}\n`);
}

function holderLine(
  id: string,
  name: string,
  options: {
    composeProject?: string;
    workingDir?: string;
    ports?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    id,
    name: `/${name}`,
    labels: {
      "com.docker.compose.project": options.composeProject,
      "com.docker.compose.project.working_dir": options.workingDir,
    },
    ports: options.ports ?? {},
  });
}

function mockSpawnSequence(outputs: (() => never)[]): void {
  for (const output of outputs) vi.mocked(spawnSync).mockReturnValueOnce(output());
}

describe("resolveFixedPublishedHostPorts", () => {
  it("extracts fixed bindings and keeps ephemeral bindings out", () => {
    const model = {
      services: {
        azurite: {
          ports: [
            {
              mode: "ingress",
              host_ip: "127.0.0.1",
              target: 10000,
              published: "10003",
              protocol: "tcp",
            },
            {
              mode: "ingress",
              host_ip: "127.0.0.1",
              target: 10001,
              published: "",
              protocol: "tcp",
            },
            { mode: "ingress", host_ip: "127.0.0.1", target: 10002, protocol: "tcp" },
            { mode: "ingress", host_ip: "127.0.0.1", target: 10004, published: 0, protocol: "tcp" },
            {
              mode: "ingress",
              host_ip: "127.0.0.1",
              target: 10005,
              published: "0",
              protocol: "tcp",
            },
          ],
        },
      },
    };
    expect(resolveFixedPublishedHostPorts(model)).toEqual([
      {
        service: "azurite",
        hostIp: "127.0.0.1",
        hostPort: 10003,
        protocol: "tcp",
      },
    ]);
  });

  it("treats wildcard host ips as null", () => {
    const model = {
      services: {
        a: { ports: [{ target: 80, published: "8080" }] },
        b: { ports: [{ host_ip: "0.0.0.0", target: 81, published: "8081" }] },
        c: { ports: [{ host_ip: "::", target: 82, published: "8082" }] },
        d: { ports: [{ host_ip: "127.0.0.1", target: 83, published: "8083" }] },
      },
    };
    expect(resolveFixedPublishedHostPorts(model).map((binding) => binding.hostIp)).toEqual([
      null,
      null,
      null,
      "127.0.0.1",
    ]);
  });

  it("expands bounded published ranges and keeps the protocol", () => {
    const model = {
      services: {
        mesh: {
          ports: [
            { host_ip: "127.0.0.1", target: 7000, published: "10003-10005", protocol: "udp" },
          ],
        },
      },
    };
    expect(resolveFixedPublishedHostPorts(model)).toEqual([
      { service: "mesh", hostIp: "127.0.0.1", hostPort: 10003, protocol: "udp" },
      { service: "mesh", hostIp: "127.0.0.1", hostPort: 10004, protocol: "udp" },
      { service: "mesh", hostIp: "127.0.0.1", hostPort: 10005, protocol: "udp" },
    ]);
  });

  it("fails closed on unsupported entries, invalid ranges, and oversized totals", () => {
    expect(() =>
      resolveFixedPublishedHostPorts({ services: { a: { ports: ["127.0.0.1:10003:10000"] } } }),
    ).toThrow(/unsupported port entry/);
    expect(() =>
      resolveFixedPublishedHostPorts({
        services: { a: { ports: [{ target: 1, published: "10-3" }] } },
      }),
    ).toThrow(/invalid host port range/);
    expect(() =>
      resolveFixedPublishedHostPorts({
        services: { a: { ports: [{ target: 1, published: "100-20000" }] } },
      }),
    ).toThrow(/more than .* fixed host ports/);
  });

  it("returns no bindings for models without ports", () => {
    expect(resolveFixedPublishedHostPorts({ services: { a: {} } })).toEqual([]);
    expect(resolveFixedPublishedHostPorts(undefined)).toEqual([]);
  });
});

describe("hostPortBindingsConflict", () => {
  const cases: [
    string,
    { hostIp: string | null; hostPort: number; protocol: string },
    { hostIp: string | null; hostPort: number; protocol: string },
    boolean,
  ][] = [
    [
      "exact match",
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      true,
    ],
    [
      "wildcard desired",
      { hostIp: null, hostPort: 10003, protocol: "tcp" },
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      true,
    ],
    [
      "wildcard holder",
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      { hostIp: null, hostPort: 10003, protocol: "tcp" },
      true,
    ],
    [
      "different specific ips",
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      { hostIp: "10.0.0.5", hostPort: 10003, protocol: "tcp" },
      false,
    ],
    [
      "different ports",
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      { hostIp: "127.0.0.1", hostPort: 10004, protocol: "tcp" },
      false,
    ],
    [
      "different protocols",
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "tcp" },
      { hostIp: "127.0.0.1", hostPort: 10003, protocol: "udp" },
      false,
    ],
  ];
  for (const [name, desired, holder, expected] of cases) {
    it(name, () => {
      expect(hostPortBindingsConflict(desired, holder)).toBe(expected);
    });
  }
});

describe("detectHostPortClaimConflicts", () => {
  function configureDetection(options: {
    rendered: () => never;
    ps?: () => never;
    holders?: () => never;
  }): void {
    mockSpawnSequence([options.rendered]);
    if (options.ps) mockSpawnSequence([options.ps]);
    if (options.holders) mockSpawnSequence([options.holders]);
  }

  it("does not touch Docker when the model has no fixed bindings", () => {
    configureDetection({ rendered: () => renderedModel({ app: { ports: [] } }) });
    expect(detectHostPortClaimConflicts({ repoPath: REPO, plan: PLAN })).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("refuses a foreign holder with attribution and remediation", () => {
    configureDetection({
      rendered: () =>
        renderedModel({
          azurite: {
            ports: [{ host_ip: "127.0.0.1", target: 10000, published: "10003", protocol: "tcp" }],
          },
        }),
      ps: () => dockerResult("abc123\n"),
      holders: () =>
        dockerResult(
          `${holderLine("abc123", "default-fe-d0f0d-azurite-1", {
            composeProject: "default-fe-d0f0d",
            workingDir: FOREIGN_DIR,
            ports: { "10000/tcp": [{ HostIp: "127.0.0.1", HostPort: "10003" }] },
          })}\n`,
        ),
    });
    vi.mocked(listWorkspaceOwnership).mockReturnValue([
      {
        version: 1,
        workspace: "feat-kb-capacity",
        worktreePath: "/tmp/host-port-claims-test/other",
        branch: "feat/kb-capacity",
        devpodId: "default-fe-d0f0d",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    ]);

    const conflicts = detectHostPortClaimConflicts({
      repoPath: REPO,
      plan: PLAN,
      workspace: {
        token: "feat-ai-cost-controls",
        gitCommonDir: "/tmp/host-port-claims-test/common",
      },
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      service: "azurite",
      hostIp: "127.0.0.1",
      hostPort: 10003,
      protocol: "tcp",
      holderContainer: "default-fe-d0f0d-azurite-1",
      holderComposeProject: "default-fe-d0f0d",
      holderWorktreePath: "/tmp/host-port-claims-test/other",
      holderWorkspace: "feat-kb-capacity",
      holderBranch: "feat/kb-capacity",
    });
    expect(conflicts[0].remediation).toContain("devrouter stop /tmp/host-port-claims-test/other");

    const [, renderArgs, renderOptions] = vi.mocked(spawnSync).mock.calls[0];
    expect(renderArgs).toEqual(
      expect.arrayContaining([
        "compose",
        "--profile",
        "*",
        "--project-directory",
        PLAN.composeDirectory,
      ]),
    );
    expect(renderOptions).toMatchObject({ cwd: PLAN.composeDirectory });
    expect((renderOptions as { env?: Record<string, string> }).env?.WORKSPACE).toBe(
      "feat-ai-cost-controls",
    );
    const [, psArgs] = vi.mocked(spawnSync).mock.calls[1];
    expect(psArgs).toEqual(["ps", "--filter", "status=running", "--format", "{{.ID}}"]);
    const [, inspectArgs] = vi.mocked(spawnSync).mock.calls[2];
    expect(inspectArgs?.[0]).toBe("inspect");
    expect(String(inspectArgs?.[2])).toContain("NetworkSettings.Ports");
  });

  it("excludes the target's own containers from the refusal", () => {
    configureDetection({
      rendered: () =>
        renderedModel({
          azurite: {
            ports: [{ host_ip: "127.0.0.1", target: 10000, published: "10003", protocol: "tcp" }],
          },
        }),
      ps: () => dockerResult("abc123\n"),
      holders: () =>
        dockerResult(
          `${holderLine("abc123", "default-fe-76faa-azurite-1", {
            composeProject: "default-fe-76faa",
            workingDir: DEVCONTAINER_DIR,
            ports: { "10000/tcp": [{ HostIp: "127.0.0.1", HostPort: "10003" }] },
          })}\n`,
        ),
    });
    expect(detectHostPortClaimConflicts({ repoPath: REPO, plan: PLAN })).toEqual([]);
  });

  it("keeps a conflict when the holder has no compose labels", () => {
    configureDetection({
      rendered: () =>
        renderedModel({
          postgres: {
            ports: [{ target: 5432, published: "5432", protocol: "tcp" }],
          },
        }),
      ps: () => dockerResult("def456\n"),
      holders: () =>
        dockerResult(
          `${JSON.stringify({
            id: "def456",
            name: "/standalone-postgres",
            labels: {},
            ports: { "5432/tcp": [{ HostIp: "", HostPort: "5432" }] },
          })}\n`,
        ),
    });
    const conflicts = detectHostPortClaimConflicts({ repoPath: REPO, plan: PLAN });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      holderContainer: "standalone-postgres",
      hostIp: null,
      hostPort: 5432,
    });
    expect(conflicts[0].holderWorkspace).toBeUndefined();
    expect(conflicts[0].remediation).toContain("standalone-postgres");
  });

  it("refuses when the live holder listing fails", () => {
    configureDetection({
      rendered: () =>
        renderedModel({
          azurite: {
            ports: [{ host_ip: "127.0.0.1", target: 10000, published: "10003", protocol: "tcp" }],
          },
        }),
      ps: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }) as never,
    });
    expect(() => detectHostPortClaimConflicts({ repoPath: REPO, plan: PLAN })).toThrow(
      /Cannot connect to the Docker daemon/,
    );
  });

  it("refuses when the compose model cannot be rendered", () => {
    configureDetection({
      rendered: () =>
        ({
          status: 1,
          stdout: "",
          stderr: "invalid interpolation in docker-compose.devrouter.yml",
        }) as never,
    });
    expect(() => detectHostPortClaimConflicts({ repoPath: REPO, plan: PLAN })).toThrow(
      /could not render the managed Compose model/,
    );
  });
});
