import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasExactComposeIdentity,
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectManagedStopRunnerId,
  inspectWorkspaceContainers,
  resolveManagedStopEndpoint,
  stopPinnedManagedContainer,
  supportsManagedStopBaseline,
} from "../devpod-environment";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inspectWorkspaceContainers", () => {
  it("lists every container and inspects it without paying for size reporting", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "abc123\ndef456\n", stderr: "" } as never)
      .mockReturnValueOnce({
        status: 0,
        stdout: `${snapshotLine("abc123")}\n`,
        stderr: "",
      } as never);

    expect(inspectWorkspaceContainers()).toEqual([expect.objectContaining({ id: "abc123" })]);

    const [, inspectArgs] = vi.mocked(spawnSync).mock.calls[1];
    // Sizing costs the daemon a filesystem walk per container, and the callers
    // on the `ensure`/`exec` hot path never need it.
    expect(inspectArgs).not.toContain("--size");
    expect(inspectArgs?.slice(-2)).toEqual(["abc123", "def456"]);
    expect(String(inspectArgs?.[2])).not.toContain("SizeRw");
  });

  it("asks for sizes only on the named containers and keeps the shared fields", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: `${snapshotLine("abc123", { sizeRw: 10, sizeRootFs: 90 })}\n`,
      stderr: "",
    } as never);

    expect(inspectWorkspaceContainers({ withSize: true, ids: ["abc123"] })).toEqual([
      expect.objectContaining({ id: "abc123", sizeRw: 10, sizeRootFs: 90 }),
    ]);

    // No `docker ps`: an explicit id list is the whole population.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(spawnSync).mock.calls[0];
    expect(args).toContain("--size");
    const template = String(args?.[args.indexOf("--format") + 1]);
    // The size template is derived from the shared one, so it must still carry
    // every field the attribution pass depends on rather than replacing them.
    expect(template).toContain("mounts");
    expect(template).toContain("com.docker.compose.project.working_dir");
    expect(template).toContain('"sizeRw"');
  });

  it("names the spawn failure when the docker binary is missing", () => {
    // ENOENT leaves both streams null, so without the error message the caller
    // would only ever see "unknown error".
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: null,
      stderr: null,
      error: new Error("spawn docker ENOENT"),
    } as never);

    expect(() => inspectWorkspaceContainers()).toThrow(/spawn docker ENOENT/);
  });

  it("surfaces the daemon's own error when listing exits non-zero", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon\n",
      error: undefined,
    } as never);

    expect(() => inspectWorkspaceContainers()).toThrow(/Cannot connect to the Docker daemon/);
  });
});

describe("inspectManagedStopContainers", () => {
  const composeProject = "devsy-project";
  const runningId = "a".repeat(64);
  const exitedId = "b".repeat(64);
  const createdId = "c".repeat(64);
  const unexpectedId = "d".repeat(64);

  it("returns a stable running and quiescent population with bounded safe inspection", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(`${runningId}\n${exitedId}\n${createdId}\n`))
      .mockReturnValueOnce(
        dockerResult(
          `${managedSnapshotLine(runningId, composeProject, "running")}
${managedSnapshotLine(exitedId, composeProject, "exited")}
${managedSnapshotLine(createdId, composeProject, "created")}
`,
        ),
      )
      .mockReturnValueOnce(dockerResult(`${runningId}\n${exitedId}\n${createdId}\n`));

    expect(inspectManagedStopContainers(composeProject)).toEqual([
      expect.objectContaining({
        id: runningId,
        state: expect.objectContaining({ Status: "running" }),
      }),
      expect.objectContaining({
        id: exitedId,
        state: expect.objectContaining({ Status: "exited" }),
      }),
      expect.objectContaining({
        id: createdId,
        state: expect.objectContaining({ Status: "created" }),
      }),
    ]);

    expect(vi.mocked(spawnSync).mock.calls[0][1]).toEqual([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.ID}}",
    ]);
    const inspectCall = vi.mocked(spawnSync).mock.calls[1];
    expect(inspectCall[1]).toEqual([
      "inspect",
      "--format",
      expect.stringContaining('"Paused"'),
      runningId,
      exitedId,
      createdId,
    ]);
    expect(inspectCall[2]).toMatchObject({
      encoding: "utf-8",
      timeout: expect.any(Number),
      maxBuffer: expect.any(Number),
    });
    expect(String((inspectCall[1] as string[])[2])).not.toContain("Env");
    expect(String((inspectCall[1] as string[])[2])).not.toContain("Config.Cmd");
  });

  it("confirms an empty inventory independently without inspecting an empty id list", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(""))
      .mockReturnValueOnce(dockerResult("\n"));

    expect(inspectManagedStopContainers(composeProject)).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnSync).mock.calls.every(([, args]) => !args?.includes("inspect"))).toBe(
      true,
    );
  });

  it.each([
    ["omitted record", `${managedSnapshotLine(runningId, composeProject, "running")}`],
    [
      "duplicate record",
      `${managedSnapshotLine(runningId, composeProject, "running")}
${managedSnapshotLine(runningId, composeProject, "running")}`,
    ],
    [
      "unexpected record",
      `${managedSnapshotLine(runningId, composeProject, "running")}
${managedSnapshotLine(unexpectedId, composeProject, "exited")}`,
    ],
  ])("rejects an %s", (_name, inspectedOutput) => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(`${runningId}\n${exitedId}\n`))
      .mockReturnValueOnce(dockerResult(inspectedOutput));

    expect(() => inspectManagedStopContainers(composeProject)).toThrow();
  });

  it.each([
    ["an invalid listed id", "not-a-full-id", ""],
    ["malformed JSON", `${runningId}`, "{"],
    ["a missing state", `${runningId}`, JSON.stringify({ id: runningId })],
    [
      "a wrong field type",
      `${runningId}`,
      managedSnapshotLine(runningId, composeProject, "running", { state: { Running: "true" } }),
    ],
    [
      "a wrong mount type",
      `${runningId}`,
      managedSnapshotLine(runningId, composeProject, "running", { mounts: {} }),
    ],
  ])("rejects %s", (_name, listedOutput, inspectedOutput) => {
    if (listedOutput === "not-a-full-id") {
      vi.mocked(spawnSync).mockReturnValueOnce(dockerResult(`${listedOutput}\n`));
    } else {
      vi.mocked(spawnSync)
        .mockReturnValueOnce(dockerResult(`${listedOutput}\n`))
        .mockReturnValueOnce(dockerResult(inspectedOutput));
    }

    expect(() => inspectManagedStopContainers(composeProject)).toThrow();
  });

  it.each([
    ["running with Running false", "running", { Running: false }],
    ["exited with Running true", "exited", { Running: true }],
    ["created with Paused true", "created", { Paused: true }],
    ["created with Restarting true", "created", { Restarting: true }],
    ["created with Dead true", "created", { Dead: true }],
    ["an unknown status", "removing", { Running: false }],
  ])("rejects %s", (_name, status, state) => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(`${runningId}\n`))
      .mockReturnValueOnce(
        dockerResult(managedSnapshotLine(runningId, composeProject, status, { state })),
      );

    expect(() => inspectManagedStopContainers(composeProject)).toThrow();
  });

  it("rejects membership changes found by the independent relist", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(`${runningId}\n`))
      .mockReturnValueOnce(dockerResult(managedSnapshotLine(runningId, composeProject, "running")))
      .mockReturnValueOnce(dockerResult(`${unexpectedId}\n`));

    expect(() => inspectManagedStopContainers(composeProject)).toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("rejects transport failures from listing, inspection, and relisting", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      error: new Error("spawn failed"),
    } as never);
    expect(() => inspectManagedStopContainers(composeProject)).toThrow();

    vi.clearAllMocks();
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(`${runningId}\n`))
      .mockReturnValueOnce({ status: null, stdout: null, stderr: "" } as never);
    expect(() => inspectManagedStopContainers(composeProject)).toThrow();

    vi.clearAllMocks();
    vi.mocked(spawnSync)
      .mockReturnValueOnce(dockerResult(`${runningId}\n`))
      .mockReturnValueOnce(dockerResult(managedSnapshotLine(runningId, composeProject, "running")))
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "daemon error" } as never);
    expect(() => inspectManagedStopContainers(composeProject)).toThrow();
  });

  it("rejects an unsafe or empty Compose project before invoking Docker", () => {
    for (const project of [
      "",
      "../project",
      "Project",
      "project name",
      "project\nname",
      "project\n",
    ]) {
      expect(() => inspectManagedStopContainers(project)).toThrow();
    }
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("hasExactComposeIdentity", () => {
  const repoPath = "/workspaces/example";
  const composeFiles = [
    `${repoPath}/.devcontainer/docker-compose.yml`,
    `${repoPath}/.devcontainer/docker-compose.devrouter.yml`,
  ];

  function container(configFiles: string[]): Parameters<typeof hasExactComposeIdentity>[0] {
    return {
      id: "container-id",
      state: { Running: true },
      labels: {
        "com.docker.compose.project": "example",
        "com.docker.compose.service": "app",
        "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer`,
        "com.docker.compose.project.config_files": configFiles.join(","),
      },
      mounts: [],
      networks: {},
    };
  }

  it("accepts the Compose file generated by DevPod for container features", () => {
    expect(
      hasExactComposeIdentity(
        container([
          ...composeFiles,
          "/Users/test/.devpod/agent/contexts/context/workspaces/example/.docker-compose/docker-compose.devcontainer.containerFeatures-8.yml",
        ]),
        { repoPath, service: "app", composeProject: "example", composeFiles },
      ),
    ).toBe(true);
  });

  it("accepts the Compose file generated by Devsy for container features", () => {
    expect(
      hasExactComposeIdentity(
        container([
          ...composeFiles,
          "/Users/test/.devsy/contexts/default/workspaces/example/agent/.docker-compose/docker-compose.devcontainer.containerFeatures-8.yml",
        ]),
        { repoPath, service: "app", composeProject: "example", composeFiles },
      ),
    ).toBe(true);
  });

  it("rejects a similarly named Devsy provider directory", () => {
    expect(
      hasExactComposeIdentity(
        container([
          ...composeFiles,
          "/Users/test/xdevsy/contexts/default/workspaces/example/agent/.docker-compose/docker-compose.devcontainer.containerFeatures-8.yml",
        ]),
        { repoPath, service: "app", composeProject: "example", composeFiles },
      ),
    ).toBe(false);
  });

  it("rejects an unexpected consumer Compose overlay", () => {
    expect(
      hasExactComposeIdentity(container([...composeFiles, "/tmp/foreign-compose.yml"]), {
        repoPath,
        service: "app",
        composeProject: "example",
        composeFiles,
      }),
    ).toBe(false);
  });
});

function snapshotLine(id: string, sizes?: { sizeRw: number; sizeRootFs: number }): string {
  return JSON.stringify({
    id,
    state: { Running: true, Health: null },
    labels: { "com.docker.compose.project.working_dir": "/repo/trees/feature/.devcontainer" },
    mounts: [{ Type: "bind", Source: "/repo/trees/feature", Destination: "/workspaces/app" }],
    networks: {},
    ...sizes,
  });
}

function dockerResult(stdout: string): never {
  return { status: 0, stdout, stderr: "" } as never;
}

function managedSnapshotLine(
  id: string,
  composeProject: string,
  status: string,
  overrides: {
    state?: Record<string, unknown>;
    labels?: Record<string, unknown>;
    mounts?: unknown;
    networks?: unknown;
  } = {},
): string {
  return JSON.stringify({
    id,
    state: {
      Status: status,
      Running: status === "running",
      Paused: false,
      Restarting: false,
      Dead: false,
      Health: null,
      ...overrides.state,
    },
    labels: {
      "com.docker.compose.project": composeProject,
      "com.docker.compose.service": "app",
      "com.docker.compose.project.working_dir": "/workspaces/example/.devcontainer",
      "com.docker.compose.project.config_files": "/workspaces/example/.devcontainer/compose.yml",
      "com.docker.compose.config-hash": "synthetic-hash",
      ...overrides.labels,
    },
    mounts: overrides.mounts ?? [
      {
        Type: "bind",
        Source: "/workspaces/example",
        Destination: "/workspaces/example",
      },
    ],
    networks: overrides.networks ?? {},
  });
}

describe("pinned managed stop Docker operations", () => {
  it("pins every population request despite ambient Docker selection", () => {
    vi.stubEnv("DOCKER_CONTEXT", "other");
    vi.stubEnv("DOCKER_HOST", "unix:///other.sock");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    try {
      expect(inspectManagedStopContainers("fixture", "unix:///synthetic.sock")).toEqual([]);
      expect(spawnSync).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(spawnSync).mock.calls) {
        expect(call[1]?.slice(0, 2)).toEqual(["--host", "unix:///synthetic.sock"]);
        const options = call[2] as { env: NodeJS.ProcessEnv };
        expect(options.env.DOCKER_CONTEXT).toBeUndefined();
        expect(options.env.DOCKER_HOST).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads only the daemon and runner identifiers and stops one exact ID", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify("synthetic-daemon"),
        stderr: "",
      } as never)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify("synthetic-runner"),
        stderr: "",
      } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never);
    expect(inspectManagedStopDaemon("unix:///synthetic.sock")).toBe("synthetic-daemon");
    expect(inspectManagedStopRunnerId("unix:///synthetic.sock", "a".repeat(64))).toBe(
      "synthetic-runner",
    );
    stopPinnedManagedContainer("unix:///synthetic.sock", "a".repeat(64));
    expect(spawnSync).toHaveBeenLastCalledWith(
      "docker",
      ["--host", "unix:///synthetic.sock", "stop", "a".repeat(64)],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(() => stopPinnedManagedContainer("unix:///synthetic.sock", "short-id")).toThrow(Error);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("rejects unavailable daemon evidence without exposing provider output", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "synthetic-private-output",
      stderr: "",
    } as never);
    let failure: unknown;
    try {
      inspectManagedStopDaemon("unix:///synthetic.sock");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("synthetic-private-output");
  });

  it.each([
    "tcp://synthetic.example:2376",
    "ssh://fixture@synthetic.example",
    "npipe:////./pipe/docker_engine",
  ])("recognizes %s without enabling pinned local operations", (endpoint) => {
    vi.stubEnv("DOCKER_CONTEXT", "");
    vi.stubEnv("DOCKER_HOST", endpoint);
    try {
      expect(resolveManagedStopEndpoint()).toBe(endpoint);
      expect(supportsManagedStopBaseline(endpoint)).toBe(false);
      expect(() => inspectManagedStopDaemon(endpoint)).toThrow(Error);
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "",
    "tcp://",
    "tcp://host:99999",
    "tcp://host:abc",
    "unknown://host",
    "unix://relative",
    "ssh://",
    "tcp://host\n",
  ])("rejects malformed endpoint %j", (endpoint) => {
    expect(() => supportsManagedStopBaseline(endpoint)).toThrow(Error);
  });

  it("does not fall back to DOCKER_HOST when selected context evidence is unavailable", () => {
    vi.stubEnv("DOCKER_CONTEXT", "synthetic");
    vi.stubEnv("DOCKER_HOST", "tcp://synthetic.example:2376");
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "" } as never);
    try {
      expect(resolveManagedStopEndpoint).toThrow(Error);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves the selected endpoint once before pinning", () => {
    vi.stubEnv("DOCKER_CONTEXT", "synthetic");
    vi.stubEnv("DOCKER_HOST", "tcp://ignored.example:2376");
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify("unix:///synthetic.sock"),
      stderr: "",
    } as never);
    try {
      expect(resolveManagedStopEndpoint()).toBe("unix:///synthetic.sock");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
