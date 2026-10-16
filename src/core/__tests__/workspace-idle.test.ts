import { describe, expect, it } from "vitest";
import type { HostRouteState } from "../../types";
import type { WorkspaceContainerSnapshot } from "../devpod-environment";
import { buildHostRouteRouterName } from "../host-routes";
import type { ReliabilityOperationRecord } from "../reliability-operation-store";
import {
  activitySignal,
  buildWorkspaceIdleReport,
  classifyIdle,
  type IdleSignal,
  journalVetoes,
  parseTraefikAccessLog,
  stopIdleEnvironments,
  type WorkspaceIdleDependencies,
} from "../workspace-idle";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const CUTOFF = NOW - 30 * 60 * 1000;
const OLD = "2026-10-15T10:00:00.000Z";
const RECENT = "2026-10-15T11:50:00.000Z";

function signal(source: IdleSignal["source"], status: IdleSignal["status"], timestamp?: string) {
  return { source, status, ...(timestamp ? { timestamp } : {}) } as IdleSignal;
}

function journal(
  repoPath: string,
  overrides: Partial<ReliabilityOperationRecord["state"]> = {},
  extra: Partial<ReliabilityOperationRecord> = {},
): ReliabilityOperationRecord {
  return {
    identity: { repoPath, workspace: "feature", provider: "devsy" },
    revision: 3,
    worker: null,
    state: {
      executionPolicy: "manual",
      desired: "running",
      phase: "stable",
      operation: { id: "op", kind: "ensure", drained: true, status: "COMPLETED", exitCode: 0 },
      ...overrides,
    },
    ...extra,
  } as unknown as ReliabilityOperationRecord;
}

function route(repoPath: string, name: string, updatedAt = OLD): HostRouteState {
  return {
    id: `${repoPath}::${name}`,
    name,
    host: `${name}.localhost`,
    repoPath,
    port: 3000,
    mode: "proxy",
    createdAt: OLD,
    updatedAt,
  };
}

function container(id: string, repoPath: string): WorkspaceContainerSnapshot {
  return {
    id,
    state: { Running: true },
    labels: { "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer` },
    mounts: [{ Type: "bind", Source: repoPath, Destination: "/workspaces/repo" }],
    networks: {},
  };
}

describe("classifyIdle", () => {
  it("reports idle only when every readable signal is older than the cutoff", () => {
    const result = classifyIdle(
      [
        signal("http.request", "quiet"),
        signal("devsy.activity", "missing"),
        signal("journal.write", "valid", OLD),
        signal("route.updatedAt", "valid", OLD),
      ],
      [],
      CUTOFF,
    );
    expect(result).toEqual({ status: "idle", latestActivity: OLD, reasons: [] });
  });

  it("reports active when any signal is newer than the cutoff", () => {
    const result = classifyIdle(
      [signal("http.request", "valid", RECENT), signal("journal.write", "valid", OLD)],
      [],
      CUTOFF,
    );
    expect(result.status).toBe("active");
    expect(result.reasons).toEqual(["http.request"]);
  });

  it("never reports idle while a signal is unavailable", () => {
    const result = classifyIdle(
      [
        { source: "http.request", status: "unavailable", reason: "logs rotated" },
        signal("journal.write", "valid", OLD),
      ],
      [],
      CUTOFF,
    );
    expect(result.status).toBe("unknown");
  });

  it("never reports idle without any positive evidence", () => {
    const result = classifyIdle(
      [signal("http.request", "not-applicable"), signal("devsy.activity", "missing")],
      [],
      CUTOFF,
    );
    expect(result.status).toBe("unknown");
  });

  it("lets a veto win over idle evidence", () => {
    const result = classifyIdle(
      [signal("journal.write", "valid", OLD)],
      ["pinned by a person"],
      CUTOFF,
    );
    expect(result.status).toBe("protected");
  });
});

describe("parseTraefikAccessLog", () => {
  it("keeps the newest request per file router and ignores internal routers", () => {
    const line = (time: string, router: string) =>
      `${time} 10.0.0.1 - - [15/Oct/2026:11:00:00 +0000] "GET / HTTP/2.0" 200 12 "-" "-" 7 "${router}" "http://app:3000" 4ms`;
    const parsed = parseTraefikAccessLog(
      [
        line("2026-10-15T11:00:00.000000000Z", "host-a@file"),
        line("2026-10-15T11:40:00.000000000Z", "host-a@file"),
        line("2026-10-15T11:59:00.000000000Z", "api@internal"),
        'time="2026-10-15T11:00:00Z" level=info msg="Configuration loaded"',
      ].join("\n"),
    );
    expect([...parsed.entries()]).toEqual([["host-a@file", Date.parse("2026-10-15T11:40:00Z")]]);
  });
});

describe("activitySignal", () => {
  it("treats absent activity files as missing, which still allows idle", () => {
    const result = activitySignal([
      {
        status: 1,
        stdout: "",
        stderr:
          "stat: cannot statx '/tmp/devsy.activity': No such file or directory\nstat: cannot statx '/tmp/devpod.activity': No such file or directory\n",
      },
    ]);
    expect(result.status).toBe("missing");
  });

  it("treats an exec that ended without output as unavailable", () => {
    expect(activitySignal([{ status: null, stdout: "", stderr: "" }]).status).toBe("unavailable");
  });

  it("treats a failed exec as unavailable", () => {
    const result = activitySignal([{ status: 126, stdout: "", stderr: "OCI runtime exec failed" }]);
    expect(result.status).toBe("unavailable");
  });

  it("reads the newest touch when one file exists", () => {
    const result = activitySignal([
      {
        status: 1,
        stdout: "1760526000\n",
        stderr: "stat: '/tmp/devpod.activity': No such file or directory\n",
      },
    ]);
    expect(result).toEqual({
      source: "devsy.activity",
      status: "valid",
      timestamp: new Date(1760526000 * 1000).toISOString(),
    });
  });
});

describe("journalVetoes", () => {
  it("does not veto a settled manual journal", () => {
    expect(journalVetoes(journal("/repo/a"))).toEqual([]);
  });

  it("vetoes running, unsettled, controller-managed, parked, and pinned journals", () => {
    const vetoes = journalVetoes(
      journal(
        "/repo/a",
        {
          phase: "verifying",
          executionPolicy: "capacity-managed",
          desired: "parked-for-capacity",
          operation: {
            id: "op",
            kind: "ensure",
            drained: false,
            status: "RUNNING",
            exitCode: null,
          },
        },
        {
          worker: { id: "w", operationId: "op", pid: 1, birth: "b" },
          consumerProtection: { version: 1, revision: 1, humanPinned: true },
        },
      ),
    );
    expect(vetoes).toHaveLength(6);
  });
});

function dependencies(
  overrides: Partial<WorkspaceIdleDependencies> = {},
): WorkspaceIdleDependencies {
  return {
    now: () => NOW,
    readRoutes: () => [route("/repo/trees/foo", "web"), route("/repo/trees/foo-bar", "web")],
    readJournals: () => [journal("/repo/trees/foo"), journal("/repo/trees/foo-bar")],
    journalModifiedMs: () => Date.parse(OLD),
    registryPaths: () => [],
    inspectContainers: () => [
      container("c1", "/repo/trees/foo"),
      container("c2", "/repo/trees/foo-bar"),
    ],
    statActivity: () => ({ status: 1, stdout: "", stderr: "No such file or directory" }),
    readTraefik: () => ({
      status: "ok",
      newestByRouter: new Map([
        [buildHostRouteRouterName("/repo/trees/foo-bar", "web"), Date.parse(RECENT)],
      ]),
    }),
    isConfiguredCheckout: () => true,
    gitCommonDir: () => "/repo/.git",
    ...overrides,
  };
}

describe("buildWorkspaceIdleReport", () => {
  it("credits HTTP traffic only to the exact checkout that owns the router", () => {
    const report = buildWorkspaceIdleReport({}, dependencies());
    expect(report.rows.map((row) => [row.repoPath, row.status])).toEqual([
      ["/repo/trees/foo", "idle"],
      ["/repo/trees/foo-bar", "active"],
    ]);
  });

  it("reports unknown when the Traefik window cannot be proven", () => {
    const report = buildWorkspaceIdleReport(
      {},
      dependencies({ readTraefik: () => ({ status: "unavailable", reason: "logs rotated" }) }),
    );
    expect(report.rows.map((row) => row.status)).toEqual(["unknown", "unknown"]);
  });

  it("lists checkouts without a running app container separately", () => {
    const report = buildWorkspaceIdleReport(
      {},
      dependencies({ inspectContainers: () => [container("c1", "/repo/trees/foo")] }),
    );
    expect(report.rows.map((row) => row.repoPath)).toEqual(["/repo/trees/foo"]);
    expect(report.notRunning).toEqual(["/repo/trees/foo-bar"]);
  });
});

describe("stopIdleEnvironments", () => {
  const onlyFooIdle = () => dependencies();

  it("stops an idle checkout when its journal is unchanged at the stop intent", async () => {
    const stopped: string[] = [];
    const result = await stopIdleEnvironments(
      {},
      async (repoPath, assert) => {
        assert(journal(repoPath));
        stopped.push(repoPath);
      },
      onlyFooIdle(),
    );
    expect(stopped).toEqual(["/repo/trees/foo"]);
    expect(result.stops).toEqual([{ repoPath: "/repo/trees/foo", outcome: "stopped" }]);
  });

  it("skips a checkout whose journal changed between the check and the stop intent", async () => {
    const result = await stopIdleEnvironments(
      {},
      async (repoPath, assert) => {
        assert({ ...journal(repoPath), revision: 4 });
      },
      onlyFooIdle(),
    );
    expect(result.stops[0]).toMatchObject({ outcome: "skipped" });
  });

  it("skips a checkout that became active before the stop", async () => {
    let reads = 0;
    const deps = dependencies({
      readTraefik: () => ({
        status: "ok",
        newestByRouter: new Map(
          reads++ === 0
            ? []
            : ["/repo/trees/foo", "/repo/trees/foo-bar"].map((repo) => [
                buildHostRouteRouterName(repo, "web"),
                Date.parse(RECENT),
              ]),
        ),
      }),
    });
    const stop = async () => {
      throw new Error("must not stop");
    };
    const result = await stopIdleEnvironments({}, stop, deps);
    expect(result.stops.map((entry) => [entry.repoPath, entry.outcome, entry.reason])).toEqual([
      ["/repo/trees/foo", "skipped", "now active"],
      ["/repo/trees/foo-bar", "skipped", "now active"],
    ]);
  });

  it("keeps stopping other checkouts after one stop fails", async () => {
    const deps = dependencies({ readTraefik: () => ({ status: "ok", newestByRouter: new Map() }) });
    const result = await stopIdleEnvironments(
      {},
      async (repoPath, assert) => {
        assert(journal(repoPath));
        if (repoPath === "/repo/trees/foo") throw new Error("provider failed");
      },
      deps,
    );
    expect(result.stops.map((entry) => entry.outcome)).toEqual(["failed", "stopped"]);
  });
});
