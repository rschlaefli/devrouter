import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { HostRouteState } from "../../types";
import {
  buildHostRoutesDocument,
  listHostRouteState,
  removeHostRoutesWhere,
  replaceHostRoutesForRepo,
  upsertHostRoute,
} from "../host-routes";

const execFileAsync = promisify(execFile);
const metadataPrefix = "# devrouter-routes-v1: ";

const routerPaths = vi.hoisted(() => {
  const root = `/tmp/devrouter-host-routes-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return {
    root,
    dynamicDir: `${root}/traefik/dynamic`,
    stateFile: `${root}/host-routes-state.json`,
    hostRoutesFile: `${root}/traefik/dynamic/host-routes.yml`,
  };
});

vi.mock("../router", () => ({
  DEVROUTER_HOME: routerPaths.root,
  HOST_ROUTES_STATE_FILE: routerPaths.stateFile,
  TRAEFIK_DYNAMIC_DIR: routerPaths.dynamicDir,
  TRAEFIK_HOST_ROUTES_FILE: routerPaths.hostRoutesFile,
  TCP_PROTOCOL_REGISTRY: {
    postgres: { port: 5432, entrypoint: "postgres" },
    redis: { port: 6379, entrypoint: "redis" },
    mariadb: { port: 3306, entrypoint: "mariadb" },
    mysql: { port: 3306, entrypoint: "mysql" },
  },
  isTLSEnabled: () => false,
}));

beforeEach(() => {
  fs.rmSync(routerPaths.root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(routerPaths.root, { recursive: true, force: true });
});

function makeRouteState(name: string, repoPath = "/repo", port = 3000): HostRouteState {
  const now = "2026-07-18T00:00:00.000Z";
  return {
    id: `${repoPath}::${name}`,
    name,
    host: `${name}.localhost`,
    protocol: "http",
    repoPath,
    port,
    mode: "proxy",
    upstreamHost: `${name}-app`,
    createdAt: now,
    updatedAt: now,
  };
}

function readCanonical(filePath = routerPaths.hostRoutesFile): {
  raw: string;
  metadata: { version: number; tlsEnabled: boolean; routes: HostRouteState[] };
  document: unknown;
} {
  const raw = fs.readFileSync(filePath, "utf-8");
  const [header, ...documentLines] = raw.split("\n");
  expect(header.startsWith(metadataPrefix)).toBe(true);
  const metadata = JSON.parse(
    Buffer.from(header.slice(metadataPrefix.length), "base64url").toString("utf-8"),
  );
  return { raw, metadata, document: YAML.parse(documentLines.join("\n")) };
}

describe("host route state mutation", () => {
  it("reclaims a stale route-state lock", () => {
    fs.mkdirSync(routerPaths.root, { recursive: true });
    fs.writeFileSync(`${routerPaths.stateFile}.lock`, "2147483647:stale\n");

    upsertHostRoute({
      name: "web",
      host: "web.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });

    expect(listHostRouteState()).toHaveLength(1);
    expect(fs.existsSync(`${routerPaths.stateFile}.lock`)).toBe(false);
  });

  it("selects and removes matching routes in one state mutation", () => {
    upsertHostRoute({
      name: "web",
      host: "web.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    upsertHostRoute({
      name: "api",
      host: "api.localhost",
      repoPath: "/repo",
      port: 3001,
      mode: "proxy",
    });
    upsertHostRoute({
      name: "web",
      host: "other.localhost",
      repoPath: "/other",
      port: 4000,
      mode: "proxy",
    });

    const removed = removeHostRoutesWhere(
      (route) => route.name === "web" && route.repoPath === "/repo",
    );

    expect(removed.map((route) => route.id)).toEqual(["/repo::web"]);
    expect(
      listHostRouteState()
        .map((route) => route.id)
        .sort(),
    ).toEqual(["/other::web", "/repo::api"]);
  });

  it("replaces every route for one repo in a single state mutation", () => {
    upsertHostRoute({
      name: "old",
      host: "old.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    upsertHostRoute({
      name: "other",
      host: "other.localhost",
      repoPath: "/other",
      port: 4000,
      mode: "proxy",
    });

    replaceHostRoutesForRepo("/repo", [
      {
        name: "web",
        host: "web.localhost",
        repoPath: "/repo",
        port: 3001,
        mode: "proxy",
        workspace: "feature",
      },
      {
        name: "api",
        host: "api.localhost",
        repoPath: "/repo",
        port: 3002,
        mode: "proxy",
        workspace: "feature",
      },
    ]);

    expect(
      listHostRouteState()
        .map((route) => route.id)
        .sort(),
    ).toEqual(["/other::other", "/repo::api", "/repo::web"]);
  });

  it("leaves all routes unchanged when a replacement conflicts", () => {
    upsertHostRoute({
      name: "old",
      host: "old.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    upsertHostRoute({
      name: "other",
      host: "claimed.localhost",
      repoPath: "/other",
      port: 4000,
      mode: "proxy",
    });
    const before = listHostRouteState();

    expect(() =>
      replaceHostRoutesForRepo("/repo", [
        {
          name: "web",
          host: "claimed.localhost",
          repoPath: "/repo",
          port: 3001,
          mode: "proxy",
        },
      ]),
    ).toThrow("already claimed");
    expect(listHostRouteState()).toEqual(before);
  });

  it("publishes metadata and a Traefik document from the same route generation", () => {
    upsertHostRoute({
      name: "web",
      host: "web.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });

    const canonical = readCanonical();
    expect(canonical.metadata.version).toBe(1);
    expect(canonical.document).toEqual(
      buildHostRoutesDocument(canonical.metadata.routes, canonical.metadata.tlsEnabled),
    );
  });

  it("leaves the canonical generation unchanged when the JSON stage fails", () => {
    upsertHostRoute({
      name: "old",
      host: "old.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    const before = readCanonical().raw;
    const renameSync = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination) === routerPaths.stateFile) {
        throw new Error("injected JSON rename failure");
      }
      return renameSync(source, destination);
    });

    expect(() =>
      replaceHostRoutesForRepo("/repo", [
        {
          name: "new",
          host: "new.localhost",
          repoPath: "/repo",
          port: 3001,
          mode: "proxy",
        },
      ]),
    ).toThrow("injected JSON rename failure");
    rename.mockRestore();

    expect(fs.readFileSync(routerPaths.hostRoutesFile, "utf-8")).toBe(before);
    expect(listHostRouteState().map((route) => route.name)).toEqual(["old"]);
  });

  it("keeps the prior canonical generation authoritative before canonical rename", () => {
    upsertHostRoute({
      name: "old",
      host: "old.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    const before = readCanonical().raw;
    const renameSync = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination) === routerPaths.hostRoutesFile) {
        throw new Error("injected canonical rename failure");
      }
      return renameSync(source, destination);
    });

    expect(() =>
      replaceHostRoutesForRepo("/repo", [
        {
          name: "new",
          host: "new.localhost",
          repoPath: "/repo",
          port: 3001,
          mode: "proxy",
        },
      ]),
    ).toThrow("injected canonical rename failure");
    rename.mockRestore();

    expect(fs.readFileSync(routerPaths.hostRoutesFile, "utf-8")).toBe(before);
    expect(listHostRouteState().map((route) => route.name)).toEqual(["old"]);
    expect(JSON.parse(fs.readFileSync(routerPaths.stateFile, "utf-8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "old" })]),
    );
  });

  it("recovers the new canonical generation after interruption following rename", () => {
    upsertHostRoute({
      name: "old",
      host: "old.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    const renameSync = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      const result = renameSync(source, destination);
      if (String(destination) === routerPaths.hostRoutesFile) {
        throw new Error("injected interruption after canonical rename");
      }
      return result;
    });

    expect(() =>
      replaceHostRoutesForRepo("/repo", [
        {
          name: "new",
          host: "new.localhost",
          repoPath: "/repo",
          port: 3001,
          mode: "proxy",
        },
      ]),
    ).toThrow("injected interruption after canonical rename");
    rename.mockRestore();

    expect(listHostRouteState().map((route) => route.name)).toEqual(["new"]);
    expect(JSON.parse(fs.readFileSync(routerPaths.stateFile, "utf-8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "new" })]),
    );
  });

  it("fails closed on corrupt canonical metadata instead of recreating empty state", () => {
    upsertHostRoute({
      name: "web",
      host: "web.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    const canonical = readCanonical().raw;
    fs.writeFileSync(
      routerPaths.hostRoutesFile,
      canonical.replace(/^# devrouter-routes-v1: .+$/m, "# devrouter-routes-v1: invalid!"),
      "utf-8",
    );

    expect(() => listHostRouteState()).toThrow("metadata header");
    expect(JSON.parse(fs.readFileSync(routerPaths.stateFile, "utf-8"))).toHaveLength(1);
  });

  it("migrates a completed legacy JSON and headerless YAML generation", () => {
    upsertHostRoute({
      name: "current",
      host: "current.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    const legacyRoutes = [makeRouteState("legacy", "/legacy", 4000)];
    fs.writeFileSync(routerPaths.stateFile, `${JSON.stringify(legacyRoutes, null, 2)}\n`, "utf-8");
    fs.writeFileSync(
      routerPaths.hostRoutesFile,
      YAML.stringify(buildHostRoutesDocument(legacyRoutes, false), { lineWidth: 0 }),
      "utf-8",
    );

    expect(listHostRouteState()).toEqual(legacyRoutes);
    const migrated = readCanonical();
    expect(migrated.metadata.routes).toEqual(legacyRoutes);
    expect(migrated.document).toEqual(buildHostRoutesDocument(legacyRoutes, false));
  });

  it("repairs a stale compatibility mirror from canonical metadata", () => {
    upsertHostRoute({
      name: "web",
      host: "web.localhost",
      repoPath: "/repo",
      port: 3000,
      mode: "proxy",
    });
    fs.writeFileSync(routerPaths.stateFile, "[]\n", "utf-8");

    expect(listHostRouteState().map((route) => route.name)).toEqual(["web"]);
    expect(JSON.parse(fs.readFileSync(routerPaths.stateFile, "utf-8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "web" })]),
    );
  });

  it("serializes concurrent writers without losing either route", async () => {
    const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-route-writers-"));
    const workerPath = path.join(workerHome, "writer.mts");
    const moduleUrl = pathToFileURL(path.resolve("src/core/host-routes.ts")).href;
    fs.writeFileSync(
      workerPath,
      `import hostRoutes from ${JSON.stringify(moduleUrl)};\nconst { upsertHostRoute } = hostRoutes;\nconst [name, port] = process.argv.slice(2);\nupsertHostRoute({ name, host: name + '.localhost', repoPath: '/' + name, port: Number(port), mode: 'proxy' });\n`,
      "utf-8",
    );

    try {
      const options = { cwd: process.cwd(), env: { ...process.env, HOME: workerHome } };
      await Promise.all([
        execFileAsync(process.execPath, ["--import", "tsx", workerPath, "alpha", "3001"], options),
        execFileAsync(process.execPath, ["--import", "tsx", workerPath, "beta", "3002"], options),
      ]);

      const stateFile = path.join(workerHome, ".config", "devrouter", "host-routes-state.json");
      const routes = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as HostRouteState[];
      expect(routes.map((route) => route.name).sort()).toEqual(["alpha", "beta"]);
      const canonicalFile = path.join(
        workerHome,
        ".config",
        "devrouter",
        "traefik",
        "dynamic",
        "host-routes.yml",
      );
      const canonical = readCanonical(canonicalFile);
      expect(canonical.metadata.routes.map((route) => route.name).sort()).toEqual([
        "alpha",
        "beta",
      ]);
      expect(canonical.document).toEqual(
        buildHostRoutesDocument(canonical.metadata.routes, canonical.metadata.tlsEnabled),
      );
    } finally {
      fs.rmSync(workerHome, { recursive: true, force: true });
    }
  });
});
