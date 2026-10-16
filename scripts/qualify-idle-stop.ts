import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Run manually with the absolute entry point of a built CLI candidate. It
// creates one disposable Devsy checkout, drives every idle-stop scenario against
// it with `--repo` so no other environment on the machine is ever stopped, and
// deletes the checkout's runtime and fixture at the end.
const cli = process.argv[2];
assert(
  cli && path.isAbsolute(cli) && fs.statSync(cli).isFile(),
  "Pass an absolute CLI entry point.",
);
const root = path.resolve(__dirname, "..");
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-idle-")));
const token = `idle-${randomUUID().slice(0, 8)}`;
const host = `${token}.localhost`;
const idleFor = "60s";
const idleWaitMs = 75_000;
const environment: NodeJS.ProcessEnv = { ...process.env, DEVROUTER_WORKSPACE_RUNTIME: "devsy" };
delete environment.DEVROUTER_WORKSPACE;
const evidence: Record<string, unknown> = {
  fixture,
  cliSha256: createHash("sha256").update(fs.readFileSync(cli)).digest("hex"),
  idleFor,
};
let started = false;
let failure: unknown;

function run(command: string, args: string[], timeout = 600_000): string {
  const result = spawnSync(command, args, {
    cwd: fixture,
    env: environment,
    encoding: "utf-8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fs.writeFileSync(
      path.join(fixture, "last-command.log"),
      `${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { mode: 0o600 },
    );
    throw new Error(
      `${command} ${args[1] ?? args[0]} failed (${result.status ?? result.error?.name}); see ${fixture}/last-command.log.`,
    );
  }
  return result.stdout;
}

function dev(...args: string[]): string {
  return run(process.execPath, [cli, ...args]);
}

type Row = { repoPath: string; status: string; reasons: string[] };
type Report = {
  rows: Row[];
  notRunning: string[];
  stops?: { repoPath: string; outcome: string }[];
};

function idle(...extra: string[]): Report {
  return JSON.parse(
    dev("workspace", "idle", "--repo", fixture, "--idle-for", idleFor, "--json", ...extra),
  );
}

function row(report: Report): Row | undefined {
  return report.rows.find((entry) => entry.repoPath === fixture);
}

function expectStatus(report: Report, expected: string): Row {
  const current = row(report);
  assert.equal(current?.status, expected, JSON.stringify(current ?? report));
  return current as Row;
}

function request(): void {
  run("curl", ["-skf", "-o", "/dev/null", `https://${host}/`], 30_000);
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

try {
  fs.cpSync(path.join(root, "examples/devcontainer"), fixture, { recursive: true });
  for (const relative of [
    ".devrouter.yml",
    ".devcontainer/devcontainer.json",
    ".devcontainer/devcontainer.env",
    ".devcontainer/docker-compose.yml",
    ".devcontainer/docker-compose.default.yml",
  ]) {
    const file = path.join(fixture, relative);
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replaceAll("devcontainer-demo", token));
  }
  run("git", ["init", "-q"]);
  run("git", ["add", "."]);
  run("git", [
    "-c",
    "user.name=Devrouter Fixture",
    "-c",
    "user.email=fixture@devrouter.local",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "test: initialize idle-stop fixture",
  ]);

  started = true;
  dev("ensure", fixture, "--json");
  request();

  // Devsy's own idle daemon must not run, because devrouter passes an empty timeout.
  const daemon = dev(
    "exec",
    fixture,
    "--",
    "sh",
    "-c",
    "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\"; echo; done 2>/dev/null | grep '^[^ ]*devsy internal agent container daemon' || true; cat /tmp/devsy-0/devsy.daemon.streams 2>/dev/null | tail -5 || true",
  ).trim();
  evidence.devsyDaemonProbe = daemon;
  assert.equal(daemon, "", "Devsy's idle daemon ran in the app container.");
  evidence.devsyDaemonAbsent = true;

  expectStatus(idle(), "active");

  // HTTP traffic alone keeps the environment active past the threshold.
  for (let elapsed = 0; elapsed < idleWaitMs; elapsed += 15_000) {
    request();
    sleep(15_000);
  }
  const http = expectStatus(idle(), "active");
  assert.deepEqual(http.reasons, ["http.request"], JSON.stringify(http));
  evidence.httpKeepsActive = true;

  sleep(idleWaitMs);
  expectStatus(idle(), "idle");
  evidence.untouchedBecomesIdle = true;

  // A one-shot exec counts as activity.
  dev("exec", fixture, "--", "true");
  expectStatus(idle(), "active");
  evidence.execKeepsActive = true;

  // A pin protects the environment from --stop.
  dev("workspace", "pin", fixture, "--json");
  sleep(idleWaitMs);
  expectStatus(idle(), "protected");
  const pinnedSweep = idle("--stop");
  assert.equal(pinnedSweep.stops?.length, 0);
  assert.ok(row(idle()), "A pinned environment was stopped.");
  dev("workspace", "pin", fixture, "--off", "--json");
  evidence.pinVetoesStop = true;

  // Unreadable activity evidence is unknown, and unknown never stops. A `stat`
  // earlier on PATH fails like an unreadable filesystem. Plain `docker exec`
  // places it, because a `devrouter exec` session is itself activity.
  const [container] = (row(idle()) as Row & { containerIds: string[] }).containerIds;
  const activity = (...args: string[]) => run("docker", ["exec", container, ...args]);
  activity(
    "sh",
    "-c",
    "printf '#!/bin/sh\\necho \"stat: Input/output error\" >&2\\nexit 1\\n' > /usr/local/bin/stat && chmod +x /usr/local/bin/stat",
  );
  sleep(idleWaitMs);
  const unknown = expectStatus(idle(), "unknown");
  assert.ok(
    unknown.reasons.some((reason) => reason.startsWith("devsy.activity:")),
    JSON.stringify(unknown),
  );
  const unknownSweep = idle("--stop");
  assert.equal(unknownSweep.stops?.length, 0);
  assert.ok(row(idle()), "An environment with unknown evidence was stopped.");
  activity("rm", "-f", "/usr/local/bin/stat");
  evidence.unknownEvidenceRefusesStop = true;

  // A page left open in a browser tab, without further interaction.
  const browser = spawnSync("agent-browser", ["open", `https://${host}/`], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  sleep(idleWaitMs);
  evidence.openTab =
    browser.status === 0 ? (row(idle())?.status ?? "not-running") : "agent-browser unavailable";
  spawnSync("agent-browser", ["close"], { encoding: "utf-8", timeout: 30_000 });
  if (evidence.openTab !== "idle") sleep(idleWaitMs);

  // An idle environment stops, frees its routes, and records the stop.
  // stderr is not a terminal here, as under launchd, so the sweep prints no
  // lifecycle heartbeat lines.
  const swept = spawnSync(
    process.execPath,
    [cli, "workspace", "idle", "--repo", fixture, "--idle-for", idleFor, "--stop", "--json"],
    { cwd: fixture, env: environment, encoding: "utf-8", timeout: 600_000 },
  );
  assert.equal(swept.status, 0, swept.stderr);
  assert.ok(!swept.stderr.includes("lifecycle-progress"), swept.stderr);
  evidence.sweepOmitsHeartbeat = true;
  const sweep = JSON.parse(swept.stdout) as Report;
  assert.deepEqual(sweep.stops, [{ repoPath: fixture, outcome: "stopped" }]);
  const after = idle();
  assert.equal(row(after), undefined);
  assert.ok(after.notRunning.includes(fixture));
  const routes = JSON.parse(dev("ls", "--json")) as { repoPath?: string }[];
  assert.ok(!JSON.stringify(routes).includes(fixture), "Routes survived the idle stop.");
  evidence.idleStopStopsAndFreesRoutes = true;

  // The stopped environment resumes.
  dev("ensure", fixture, "--json");
  request();
  evidence.resumes = true;
} catch (error) {
  failure = error;
} finally {
  if (started) {
    try {
      dev("stop", fixture, "--delete", "--json");
      evidence.runtimeDeleted = true;
    } catch (error) {
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!failure && evidence.runtimeDeleted) fs.rmSync(fixture, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ ok: !failure, ...evidence }, null, 2)}\n`);
}
if (failure) throw failure;
