import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLeftoverManifest,
  buildLeftoverManifest,
  type DockerContainer,
  type DockerInventory,
  type DockerRunner,
  findDockerLeftovers,
  type LeftoverContext,
  readLeftoverManifest,
} from "../docker-leftovers";
import { readManifest, sha256Hex } from "../worktree-reclaim";

vi.mock("../devsy-mutation", () => ({ withMutationLock: vi.fn() }));
vi.mock("../devpod-mutation", () => ({ withMutationLock: vi.fn() }));

const repo = "/repo";
const trees = "/repo/trees";

function container(
  project: string,
  service: string,
  options: { state?: string; checkout?: string; provider?: boolean; volumes?: string[] } = {},
): DockerContainer {
  const labels: Record<string, string> = { "com.docker.compose.project": project };
  if (options.checkout !== undefined) {
    labels["com.docker.compose.project.working_dir"] = `${options.checkout}/.devcontainer`;
  }
  if (options.provider) labels["dev.containers.id"] = project;
  return {
    id: `${project}-${service}-id`,
    name: `${project}-${service}-1`,
    state: options.state ?? "exited",
    labels,
    volumes: options.volumes ?? [],
  };
}

function stack(project: string, checkout: string, state = "exited"): DockerContainer[] {
  return [
    container(project, "app", {
      checkout,
      provider: true,
      state,
      volumes: [`${project}_node_modules`, "shared-store"],
    }),
    container(project, "postgres", { checkout, state, volumes: [`${project}_pgdata`] }),
  ];
}

function volume(name: string, project: string, createdAt = "2026-10-01T00:00:00Z") {
  return { name, labels: { "com.docker.compose.project": project }, createdAt };
}

function inventory(containers: DockerContainer[], extra: Partial<DockerInventory> = {}) {
  const projects = [
    ...new Set(containers.map((entry) => entry.labels["com.docker.compose.project"])),
  ];
  return {
    daemonId: "daemon-1",
    containers,
    volumes: projects.flatMap((project) => [
      volume(`${project}_node_modules`, project),
      volume(`${project}_pgdata`, project),
    ]),
    networks: projects.map((project) => ({
      id: `${project}-net-id`,
      name: `${project}_default`,
      labels: { "com.docker.compose.project": project },
      attached: 0,
    })),
    ...extra,
  } satisfies DockerInventory;
}

function context(present: string[], overrides: Partial<LeftoverContext> = {}): LeftoverContext {
  const existing = new Set(["/", "/repo", trees, ...present]);
  return {
    treesPath: trees,
    worktreePaths: [repo],
    ownershipPaths: [],
    providerPaths: [],
    registriesReadable: true,
    exists: (file) => existing.has(file),
    realpath: (file) => (existing.has(file) ? file : undefined),
    ...overrides,
  };
}

describe("findDockerLeftovers", () => {
  it("attributes a stopped provider stack whose checkout under trees/ vanished", () => {
    const report = findDockerLeftovers(
      inventory(stack("gone", "/repo/trees/feature")),
      context([]),
    );
    expect(report.blocked).toEqual([]);
    expect(report.leftovers).toEqual([
      {
        project: "gone",
        checkout: "/repo/trees/feature",
        containers: [
          { id: "gone-app-id", name: "gone-app-1", state: "exited" },
          { id: "gone-postgres-id", name: "gone-postgres-1", state: "exited" },
        ],
        volumes: [
          { name: "gone_node_modules", createdAt: "2026-10-01T00:00:00Z" },
          { name: "gone_pgdata", createdAt: "2026-10-01T00:00:00Z" },
        ],
        networks: [{ id: "gone-net-id", name: "gone_default" }],
      },
    ]);
  });

  it("finds nested checkouts below trees/", () => {
    const report = findDockerLeftovers(inventory(stack("gone", "/repo/trees/rs/x")), context([]));
    expect(report.leftovers.map((entry) => entry.checkout)).toEqual(["/repo/trees/rs/x"]);
  });

  it.each([
    ["a live checkout", "/repo/trees/live", ["/repo/trees/live"]],
    ["a sibling clone", "/repo-other/trees/x", []],
    ["the primary checkout", "/repo", []],
    ["a folder outside trees/", "/elsewhere/x", []],
  ])("ignores %s", (_label, checkout, present) => {
    const report = findDockerLeftovers(inventory(stack("p", checkout)), context(present));
    expect(report.leftovers).toEqual([]);
    expect(report.blocked).toEqual([]);
  });

  it("ignores a stack without the provider label", () => {
    const plain = [container("plain", "app", { checkout: "/repo/trees/x" })];
    expect(findDockerLeftovers(inventory(plain), context([])).leftovers).toEqual([]);
  });

  it("ignores everything when trees/ itself is missing, as with an unmounted volume", () => {
    const report = findDockerLeftovers(
      inventory(stack("gone", "/repo/trees/feature")),
      context([], { realpath: (file) => (file === trees ? undefined : file) }),
    );
    expect(report.leftovers).toEqual([]);
  });

  it("ignores a checkout whose resolved ancestor left trees/ through a symlink", () => {
    const report = findDockerLeftovers(
      inventory(stack("gone", "/repo/trees/link/feature")),
      context(["/repo/trees/link"], {
        realpath: (file) => (file === "/repo/trees/link" ? "/elsewhere" : file),
      }),
    );
    expect(report.leftovers).toEqual([]);
  });

  it.each([
    [{ worktreePaths: [repo, "/repo/trees/feature"] }, "git worktree prune"],
    [{ ownershipPaths: ["/repo/trees/feature"] }, "workspace gc"],
    [{ providerPaths: ["/repo/trees/feature"] }, "workspace gc"],
    [{ registriesReadable: false }, "investigate"],
  ])("blocks while a registration remains (%o)", (overrides, next) => {
    const report = findDockerLeftovers(
      inventory(stack("gone", "/repo/trees/feature")),
      context([], overrides),
    );
    expect(report.leftovers).toEqual([]);
    expect(report.blocked).toMatchObject([{ project: "gone", next }]);
  });

  it("blocks a missing subfolder of a worktree that still exists", () => {
    const stackOfSubfolder = inventory(stack("sub", "/repo/trees/live/docker"));
    const byGitEntry = findDockerLeftovers(
      stackOfSubfolder,
      context(["/repo/trees/live", "/repo/trees/live/.git"]),
    );
    expect(byGitEntry.leftovers).toEqual([]);
    expect(byGitEntry.blocked).toMatchObject([{ project: "sub", next: "investigate" }]);
    const byRegistration = findDockerLeftovers(
      stackOfSubfolder,
      context(["/repo/trees/live"], { ownershipPaths: ["/repo/trees/live"] }),
    );
    expect(byRegistration.leftovers).toEqual([]);
    expect(byRegistration.blocked).toMatchObject([{ project: "sub", next: "investigate" }]);
  });

  it("ignores a project whose containers name more than one checkout", () => {
    const shared = [
      ...stack("shared", "/repo/trees/gone"),
      container("shared", "other", { checkout: "/repo/trees/live" }),
    ];
    const report = findDockerLeftovers(inventory(shared), context(["/repo/trees/live"]));
    expect(report.leftovers).toEqual([]);
    expect(report.blocked).toEqual([]);
  });

  it("keeps anonymous volumes another stack also mounts", () => {
    const anonymous = "b".repeat(64);
    const base = inventory([
      ...stack("gone", "/repo/trees/feature").map((entry) => ({
        ...entry,
        volumes: [...entry.volumes, anonymous],
      })),
      container("live", "app", { volumes: [anonymous] }),
    ]);
    const report = findDockerLeftovers(
      { ...base, volumes: [...base.volumes, { name: anonymous, labels: {}, createdAt: "t" }] },
      context([]),
    );
    expect(report.leftovers[0].volumes.map((entry) => entry.name)).not.toContain(anonymous);
  });

  it("blocks a stack with a running container", () => {
    const report = findDockerLeftovers(
      inventory(stack("gone", "/repo/trees/feature", "running")),
      context([]),
    );
    expect(report.blocked).toMatchObject([{ project: "gone", next: "stop the stack" }]);
  });

  it("keeps explicitly named, foreign-mounted and shared volumes and attached networks", () => {
    const base = inventory([
      ...stack("gone", "/repo/trees/feature"),
      container("live", "app", { volumes: ["gone_pgdata"] }),
    ]);
    const report = findDockerLeftovers(
      {
        ...base,
        volumes: [...base.volumes, volume("custom-name", "gone"), volume("shared-store", "other")],
        networks: base.networks.map((network) => ({ ...network, attached: 1 })),
      },
      context([]),
    );
    const [leftover] = report.leftovers;
    expect(leftover.volumes.map((entry) => entry.name)).toEqual(["gone_node_modules"]);
    expect(leftover.networks).toEqual([]);
  });

  it("reports lone volumes as unattributed and never as leftovers", () => {
    const report = findDockerLeftovers(
      { daemonId: "d", containers: [], volumes: [volume("lone_root", "lone")], networks: [] },
      context([]),
    );
    expect(report.leftovers).toEqual([]);
    expect(report.unattributedVolumes).toMatchObject([{ name: "lone_root", project: "lone" }]);
  });
});

describe("leftover manifests", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-leftovers-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeManifest(
    state: DockerInventory,
    ctx: LeftoverContext,
  ): { file: string; sha: string } {
    const text = buildLeftoverManifest(repo, findDockerLeftovers(state, ctx), 1_000);
    const file = path.join(dir, "leftovers.json");
    fs.writeFileSync(file, text);
    return { file, sha: sha256Hex(text) };
  }

  type Live = { state: DockerInventory };
  function fakeDocker(live: Live, failing = new Set<string>()): DockerRunner {
    return (args) => {
      const target = args[args.length - 1];
      if (failing.has(target)) return { status: 1, stdout: "", stderr: "boom" };
      const before = JSON.stringify(live.state);
      live.state = {
        ...live.state,
        containers: live.state.containers.filter(
          (entry) => !(args[0] === "rm" && entry.id === target),
        ),
        volumes: live.state.volumes.filter(
          (entry) => !(args[0] === "volume" && entry.name === target),
        ),
        networks: live.state.networks.filter(
          (entry) => !(args[0] === "network" && entry.id === target),
        ),
      };
      if (JSON.stringify(live.state) === before) {
        return { status: 1, stdout: "", stderr: `Error: No such ${args[0]}: ${target}` };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
  }

  function apply(
    manifest: { file: string; sha: string },
    live: Live,
    ctx: LeftoverContext,
    options: { yes?: boolean; run?: DockerRunner; locks?: string[] } = {},
  ) {
    return applyLeftoverManifest(
      {
        manifestFile: manifest.file,
        sha256: manifest.sha,
        maxAgeSeconds: 3_600,
        yes: Boolean(options.yes),
      },
      {
        readInventory: () => live.state,
        readContext: () => ctx,
        run: options.run ?? fakeDocker(live),
        commonDir: () => dir,
        withLocks: (target, operation) => {
          options.locks?.push(target);
          return operation();
        },
        nowEpoch: () => 1_100,
      },
    );
  }

  it("round-trips through canonical JSON and binds the content hash", () => {
    const ctx = context([]);
    const manifest = writeManifest(inventory(stack("gone", "/repo/trees/feature")), ctx);
    expect(readLeftoverManifest(manifest.file).manifest.candidateCount).toBe(1);
    const live = { state: inventory(stack("gone", "/repo/trees/feature")) };
    expect(() => apply({ ...manifest, sha: "0".repeat(64) }, live, ctx)).toThrow(
      "SHA-256 mismatch",
    );
  });

  it("is rejected by the worktree reclaim and trim manifest reader", () => {
    const manifest = writeManifest(inventory(stack("gone", "/repo/trees/feature")), context([]));
    expect(() => readManifest(manifest.file)).toThrow(
      "manifest kind must be worktree-reclaim-manifest",
    );
  });

  it("dry-runs without touching Docker, then removes containers, volumes and networks in order", () => {
    const ctx = context([]);
    const live = { state: inventory(stack("gone", "/repo/trees/feature")) };
    const manifest = writeManifest(live.state, ctx);
    const calls: string[][] = [];
    const docker = fakeDocker(live);
    const run: DockerRunner = (args) => {
      calls.push(args);
      return docker(args);
    };
    expect(apply(manifest, live, ctx, { run }).targets).toMatchObject([{ status: "would-remove" }]);
    expect(calls).toEqual([]);
    const locks: string[] = [];
    expect(apply(manifest, live, ctx, { yes: true, run, locks }).targets).toMatchObject([
      { status: "removed" },
    ]);
    expect(locks).toEqual(["gone"]);
    // The provider-created app container proves the checkout, so it goes last.
    expect(calls).toEqual([
      ["rm", "gone-postgres-id"],
      ["rm", "gone-app-id"],
      ["volume", "rm", "gone_node_modules"],
      ["volume", "rm", "gone_pgdata"],
      ["network", "rm", "gone-net-id"],
    ]);
    expect(live.state.containers).toEqual([]);
    expect(
      fs.readdirSync(path.join(dir, "devrouter-leftovers", "receipts", manifest.sha)),
    ).toHaveLength(1);
  });

  it("finishes a partial apply on rerun and then reports it as done", () => {
    const ctx = context([]);
    const live = { state: inventory(stack("gone", "/repo/trees/feature")) };
    const manifest = writeManifest(live.state, ctx);
    const first = apply(manifest, live, ctx, {
      yes: true,
      run: fakeDocker(live, new Set(["gone_pgdata"])),
    });
    expect(first.targets).toMatchObject([{ status: "failed", code: "teardown-failed" }]);
    expect(live.state.containers).toEqual([]);
    expect(apply(manifest, live, ctx, { yes: true }).targets).toMatchObject([
      { status: "removed" },
    ]);
    expect(live.state.volumes).toEqual([]);
    expect(apply(manifest, live, ctx, { yes: true }).targets).toMatchObject([
      { status: "already-done" },
    ]);
  });

  it("finishes on rerun when a container removal failed partway", () => {
    const ctx = context([]);
    const live = { state: inventory(stack("gone", "/repo/trees/feature")) };
    const manifest = writeManifest(live.state, ctx);
    const first = apply(manifest, live, ctx, {
      yes: true,
      run: fakeDocker(live, new Set(["gone-app-id"])),
    });
    expect(first.targets).toMatchObject([{ status: "failed", code: "teardown-failed" }]);
    expect(live.state.containers.map((entry) => entry.id)).toEqual(["gone-app-id"]);
    expect(apply(manifest, live, ctx, { yes: true }).targets).toMatchObject([
      { status: "removed" },
    ]);
    expect(live.state.containers).toEqual([]);
    expect(live.state.volumes).toEqual([]);
  });

  it("lists anonymous volumes in the manifest and removes them after their containers", () => {
    const ctx = context([]);
    const anonymous = "a".repeat(64);
    const base = inventory(stack("gone", "/repo/trees/feature"));
    const live = {
      state: {
        ...base,
        containers: [
          ...base.containers,
          container("gone", "redis", { checkout: "/repo/trees/feature", volumes: [anonymous] }),
        ],
        volumes: [...base.volumes, { name: anonymous, labels: {}, createdAt: "t" }],
      },
    };
    const manifest = writeManifest(live.state, ctx);
    expect(
      readLeftoverManifest(manifest.file).manifest.candidates[0].volumes.map((entry) => entry.name),
    ).toContain(anonymous);
    apply(manifest, live, ctx, { yes: true });
    expect(live.state.volumes).toEqual([]);
  });

  it("skips a changed project and still removes the others", () => {
    const ctx = context([]);
    const live = {
      state: inventory([...stack("a", "/repo/trees/a"), ...stack("b", "/repo/trees/b")]),
    };
    const manifest = writeManifest(live.state, ctx);
    live.state = { ...live.state, containers: [...live.state.containers, container("a", "extra")] };
    const report = apply(manifest, live, ctx, { yes: true });
    expect(report.targets).toMatchObject([
      { project: "a", status: "skipped", code: "changed" },
      { project: "b", status: "removed" },
    ]);
  });

  it.each([
    [
      "the checkout reappears",
      (live: Live, ctx: LeftoverContext) => [live, context(["/repo/trees/feature"]), ctx] as const,
    ],
    [
      "a container starts",
      (live: Live) => {
        live.state = inventory(stack("gone", "/repo/trees/feature", "running"));
        return [live, context([])] as const;
      },
    ],
    [
      "another stack mounts an approved volume",
      (live: Live) => {
        live.state = {
          ...live.state,
          containers: [
            ...live.state.containers,
            container("live", "app", { volumes: ["gone_pgdata"] }),
          ],
        };
        return [live, context([])] as const;
      },
    ],
  ])("skips the project when %s", (_label, change) => {
    const live = { state: inventory(stack("gone", "/repo/trees/feature")) };
    const manifest = writeManifest(live.state, context([]));
    const [changed, ctx] = change(live, context([]));
    const before = JSON.stringify(changed.state);
    expect(apply(manifest, changed, ctx, { yes: true }).targets).toMatchObject([
      { status: "skipped" },
    ]);
    expect(JSON.stringify(changed.state)).toBe(before);
  });

  it("refuses another Docker engine", () => {
    const ctx = context([]);
    const live = { state: inventory(stack("gone", "/repo/trees/feature")) };
    const manifest = writeManifest(live.state, ctx);
    live.state = { ...live.state, daemonId: "daemon-2" };
    expect(apply(manifest, live, ctx, { yes: true }).targets).toMatchObject([
      { status: "skipped", code: "daemon-mismatch" },
    ]);
  });
});
