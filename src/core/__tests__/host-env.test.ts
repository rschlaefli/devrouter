import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceContainerSnapshot } from "../devpod-environment";
import { buildHostEnvReport, type HostEnvEvidence, parseLoopbackBinding } from "../host-env";
import { applyWorkspace, loadRepoConfig } from "../repo-config";

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

function config(workspace: string | undefined) {
  return applyWorkspace(loadRepoConfig(REPO), workspace, REPO);
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

describe("parseLoopbackBinding", () => {
  it("accepts IPv6 loopback and ignores wildcard bindings", () => {
    expect(parseLoopbackBinding("[::1]:49200\n")).toEqual({ host: "::1", port: 49200 });
    expect(parseLoopbackBinding("0.0.0.0:49200\n[::]:49200\n")).toBeUndefined();
  });
});
