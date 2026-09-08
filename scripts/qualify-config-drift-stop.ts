import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

// Run manually with the absolute entry point of an unpacked CLI candidate.
// The fixture and its volumes remain available for inspection after shutdown.
const cli = process.argv[2];
assert(
  cli && path.isAbsolute(cli) && fs.statSync(cli).isFile(),
  "Pass an absolute CLI entry point.",
);
const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-stop-drift-"));
const token = `stop-drift-${randomUUID().slice(0, 8)}`;
const marker = randomUUID();
const environment: NodeJS.ProcessEnv = { ...process.env, DEVROUTER_WORKSPACE_RUNTIME: "devsy" };
delete environment.DEVROUTER_WORKSPACE;
const moved: Array<[string, string]> = [];
let attemptedStartup = false;
let providerId: string | undefined;
let failure: unknown;
const evidence: Record<string, unknown> = {
  fixture,
  cli,
  cliSha256: createHash("sha256").update(fs.readFileSync(cli)).digest("hex"),
  configurationDriftStop: false,
  tmpfsMount: false,
  retainedData: false,
  finalStopped: false,
};

function run(command: string, args: string[], timeout = 600_000): string {
  const result = spawnSync(command, args, {
    cwd: fixture,
    env: environment,
    encoding: "utf-8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // All command inputs belong to this synthetic fixture. Keep provider output
    // local because it can also contain machine-specific diagnostics.
    fs.writeFileSync(
      path.join(fixture, "last-command.log"),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { mode: 0o600 },
    );
    throw new Error(
      `${command} failed (${result.status ?? result.error?.name}); see fixture last-command.log.`,
    );
  }
  return result.stdout;
}

function dev(...args: string[]): string {
  return run(process.execPath, [cli, ...args]);
}

function restoreConfiguration(): void {
  for (const [original, retained] of [...moved].reverse()) {
    assert(!fs.existsSync(original), `Configuration was unexpectedly recreated: ${original}`);
    fs.renameSync(retained, original);
    moved.splice(
      moved.findIndex((entry) => entry[0] === original),
      1,
    );
  }
}

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
  const composeFile = path.join(fixture, ".devcontainer/docker-compose.yml");
  const compose = parse(fs.readFileSync(composeFile, "utf-8"));
  compose.services.app.mem_limit = "512m";
  compose.services.app.tmpfs = ["/qualification-tmpfs:size=16m"];
  compose.services.postgres.mem_limit = "256m";
  compose.services.app.volumes.push("qualification-state:/qualification-state");
  compose.volumes["qualification-state"] = {};
  fs.writeFileSync(composeFile, stringify(compose));
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
    "test: initialize isolated stop fixture",
  ]);

  attemptedStartup = true;
  const initial = JSON.parse(dev("ensure", fixture, "--json"));
  assert.equal(initial.kind, "primary");
  assert.equal(typeof initial.devpodId, "string");
  providerId = initial.devpodId;
  dev(
    "exec",
    fixture,
    "--",
    "node",
    "-e",
    "require('node:assert/strict').ok(require('node:fs').readFileSync('/proc/mounts','utf8').split('\\n').some(line => { const fields = line.split(' '); return fields[1] === '/qualification-tmpfs' && fields[2] === 'tmpfs'; }))",
  );
  evidence.tmpfsMount = true;
  dev(
    "exec",
    fixture,
    "--",
    "node",
    "-e",
    "require('node:fs').writeFileSync('/qualification-state/marker', process.argv[1])",
    marker,
  );

  for (const relative of [
    ".devrouter.yml",
    ".devcontainer/devcontainer.json",
    ".devcontainer/devcontainer.devrouter.json",
    ".devcontainer/docker-compose.yml",
  ]) {
    const original = path.join(fixture, relative);
    const retained = `${original}.qualification-retained`;
    assert(fs.existsSync(original), `Expected prepared configuration: ${relative}`);
    assert(!fs.existsSync(retained));
    fs.renameSync(original, retained);
    moved.push([original, retained]);
  }
  const stopped = JSON.parse(dev("stop", fixture, "--json"));
  assert.equal(stopped.stopped, true);
  evidence.configurationDriftStop = true;
  restoreConfiguration();

  const resumed = JSON.parse(dev("ensure", fixture, "--json"));
  assert.equal(resumed.devpodId, providerId);
  dev(
    "exec",
    fixture,
    "--",
    "node",
    "-e",
    "require('node:assert/strict').equal(require('node:fs').readFileSync('/qualification-state/marker','utf8'), process.argv[1])",
    marker,
  );
  evidence.retainedData = true;
} catch (error) {
  failure = error;
} finally {
  try {
    restoreConfiguration();
  } catch (restoreError) {
    failure = new AggregateError(
      [failure, restoreError].filter(Boolean),
      "Qualification configuration restoration failed.",
    );
  }
  try {
    if (attemptedStartup) {
      assert.equal(JSON.parse(dev("stop", fixture, "--json")).stopped, true);
      assert.equal(JSON.parse(dev("stop", fixture, "--json")).stopped, true);
      if (providerId) {
        const status = JSON.parse(
          run("devsy", ["workspace", "status", providerId, "--result-format", "json"], 30_000),
        );
        assert.equal(status.id, providerId);
        assert.equal(status.state, "Stopped");
        const { routes } = JSON.parse(dev("ls", "--json"));
        assert(Array.isArray(routes));
        assert(
          !routes.some((route: { hosts: string[] }) =>
            route.hosts.some(
              (host) => host === `${token}.localhost` || host === `db.${token}.localhost`,
            ),
          ),
        );
        evidence.finalStopped = true;
      }
    }
  } catch (cleanupError) {
    failure = new AggregateError(
      [failure, cleanupError].filter(Boolean),
      "Qualification or exact cleanup failed.",
    );
  }
  evidence.passed =
    !failure &&
    evidence.tmpfsMount &&
    evidence.configurationDriftStop &&
    evidence.retainedData &&
    evidence.finalStopped;
  fs.writeFileSync(
    path.join(fixture, "qualification.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${path.join(fixture, "qualification.json")}\n`);
}
if (failure) throw failure;
assert.equal(evidence.passed, true);
