import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  idleSweepCheck,
  idleSweepPaths,
  installIdleSweep,
  readInstalledIdleFor,
  removeIdleSweep,
  resolveIdleSweepEnvironment,
  summarizeSweep,
  writeLastSweep,
} from "../idle-sweep";

let home: string;
let calls: string[][];
const launchctl = (args: string[]) => {
  calls.push(args);
  return { status: 0, stderr: "" };
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-idle-sweep-"));
  calls = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function paths() {
  return idleSweepPaths(home, path.join(home, ".config", "devrouter"));
}

describe("installIdleSweep", () => {
  it("writes an agent with absolute tool paths and the shell's Docker endpoint", () => {
    const environment = resolveIdleSweepEnvironment(
      { HOME: home, DOCKER_HOST: "unix:///synthetic/docker.sock" },
      (name) => (name === "docker" ? "/opt/synthetic/bin/docker" : undefined),
    );
    installIdleSweep({
      idleFor: "45m",
      paths: paths(),
      environment,
      entryPath: "/opt/synthetic/devrouter.js",
      launchctl,
    });

    const plist = fs.readFileSync(paths().plist, "utf-8");
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain("<string>/opt/synthetic/devrouter.js</string>");
    expect(plist).toContain("<string>unix:///synthetic/docker.sock</string>");
    expect(environment.PATH.split(":")[0]).toBe("/opt/synthetic/bin");
    expect(readInstalledIdleFor(paths().plist)).toBe("45m");
    expect(calls.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
  });

  it("rewrites an existing agent instead of adding a second one", () => {
    const common = {
      paths: paths(),
      environment: { PATH: "/usr/bin" },
      entryPath: "/e.js",
      launchctl,
    };
    installIdleSweep({ ...common, idleFor: "30m" });
    installIdleSweep({ ...common, idleFor: "2h" });
    expect(readInstalledIdleFor(paths().plist)).toBe("2h");
    expect(fs.readdirSync(path.dirname(paths().plist))).toHaveLength(1);
  });

  it("refuses when docker cannot be located", () => {
    expect(() => resolveIdleSweepEnvironment({}, () => undefined)).toThrow("docker is not on PATH");
  });

  it("removes the agent and treats absence as already off", () => {
    installIdleSweep({
      idleFor: "30m",
      paths: paths(),
      environment: { PATH: "/usr/bin" },
      entryPath: "/e.js",
      launchctl,
    });
    expect(removeIdleSweep({ paths: paths(), launchctl })).toBe(true);
    expect(fs.existsSync(paths().plist)).toBe(false);
    expect(removeIdleSweep({ paths: paths(), launchctl })).toBe(false);
  });
});

describe("idleSweepCheck", () => {
  const install = () =>
    installIdleSweep({
      idleFor: "30m",
      paths: paths(),
      environment: { PATH: "/usr/bin" },
      entryPath: "/e.js",
      launchctl,
    });

  it("reports idle stop as off without an agent", () => {
    expect(idleSweepCheck(paths())).toMatchObject({ id: "global.idle-stop", level: "ok" });
  });

  it("separates a sweep that could not inspect environments from one that stopped nothing", () => {
    install();
    writeLastSweep(summarizeSweep("30m", [], new Error("docker ps failed")), paths());
    const failed = idleSweepCheck(paths());
    expect(failed.level).toBe("warn");
    expect(failed.details).toContain("docker ps failed");

    writeLastSweep(summarizeSweep("30m", []), paths());
    expect(idleSweepCheck(paths()).level).toBe("ok");
  });

  it("warns when the agent stopped recording sweeps", () => {
    install();
    writeLastSweep(summarizeSweep("30m", []), paths());
    expect(idleSweepCheck(paths(), Date.now() + 60 * 60 * 1000).level).toBe("warn");
  });
});
