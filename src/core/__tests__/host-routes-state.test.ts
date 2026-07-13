import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listHostRouteState,
  removeHostRoutesWhere,
  replaceHostRoutesForRepo,
  upsertHostRoute,
} from "../host-routes";

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
  fs.rmSync(routerPaths.root, { recursive: true, force: true });
});

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
});
