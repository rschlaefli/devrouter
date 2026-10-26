/**
 * Qualify managed runtime variants and host-port discovery on two independent
 * primary Git checkouts. Runtimes are retained and stopped; nothing is deleted.
 *
 * Exit 0 means every assertion passed. Exit 1 is a failed qualification. Exit 3
 * means a prerequisite was unavailable before any fixture was created.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKSPACE_FOLDER = "/workspaces/runtime-inputs";
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const FINAL_STOP_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_STREAMED_STDERR = 32 * 1024;

type JsonObject = Record<string, unknown>;

type Fixture = {
  role: "a" | "b";
  id: string;
  checkout: string;
  routeHost: string;
  routeUrl: string;
  attempted: boolean;
  devpodId?: string;
  composeProject?: string;
  appContainer?: string;
  portContainer?: string;
};

type CommandResult = {
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderrTail: string;
};

type Prerequisites = {
  candidate: string;
  candidateSha256: string;
  caPath: string;
  dockerVersion: string;
  devsyVersion: string;
  image: string;
  imageId: string;
};

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringField(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok((value as string).length > 0, `${label} must not be empty`);
  return value as string;
}

function numberField(value: unknown, label: string): number {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isInteger(value), `${label} must be an integer`);
  return value as number;
}

function objectField(value: unknown, label: string): JsonObject {
  const object = asObject(value);
  assert.ok(object, `${label} must be an object`);
  return object as JsonObject;
}

function arrayField(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value as unknown[];
}

function parseObjectJson(output: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
  const object = asObject(parsed);
  assert.ok(object, `${label} must return a JSON object.`);
  return object as JsonObject;
}

function truncate(value: string, length = 1_500): string {
  return value.length <= length ? value : value.slice(-length);
}

function unavailable(reason: string): never {
  process.stderr.write(`Runtime-input qualification prerequisites unavailable: ${reason}\n`);
  process.exit(3);
}

const commandEnvironment: NodeJS.ProcessEnv = { ...process.env };
for (const name of [
  "WORKSPACE",
  "DEVROUTER_WORKSPACE",
  "DEVROUTER_GIT_COMMON_DIR",
  "DEVCONTAINER_COMPOSE_OVERLAY",
  "DEVROUTER_PROCESS_HELPER",
  "DEVROUTER_PROCESS_ADAPTER_SHA256",
  "DEVROUTER_PROCESS_HOST_PORTS_SHA256",
  "DEVROUTER_RUNTIME_VARIANT",
  "DEVROUTER_PROFILE",
  "DEVROUTER_PROCESS_SET",
  "DEVROUTER_PROCESS_FINGERPRINT_ENV",
  "DEVROUTER_HOST_PORT_PROBE",
]) {
  delete commandEnvironment[name];
}
commandEnvironment.DEVROUTER_WORKSPACE_RUNTIME = "devsy";

function runSync(command: string, args: string[], timeout = 60_000) {
  return spawnSync(command, args, {
    cwd: path.dirname(process.execPath),
    env: commandEnvironment,
    encoding: "utf-8",
    timeout,
    maxBuffer: MAX_OUTPUT,
  });
}

function requireSync(command: string, args: string[], label = command, timeout = 60_000): string {
  const result = runSync(command, args, timeout);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || truncate(String(result.stderr || result.stdout || ""));
    throw new Error(`${label} failed${detail ? `: ${detail}` : "."}`);
  }
  return String(result.stdout || "").trim();
}

function prerequisites(sourceRoot: string): Prerequisites {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) unavailable("Node.js 24 or newer is required.");

  const candidate = path.resolve(sourceRoot, "dist/devrouter.js");
  if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile()) {
    unavailable("build dist/devrouter.js first (pnpm build).");
  }

  for (const [command, args] of [
    ["git", ["--version"]],
    ["docker", ["version", "--format", "{{.Server.Version}}"]],
    ["devsy", ["--version"]],
    ["curl", ["--version"]],
    ["mkcert", ["-CAROOT"]],
  ] as const) {
    const probe = runSync(command, [...args]);
    if (probe.error || probe.status !== 0) unavailable(`${command} is unavailable.`);
  }

  const image = (process.env.DR_RUNTIME_INPUTS_IMAGE || "node:20").trim();
  if (!image || /\s/.test(image))
    unavailable("DR_RUNTIME_INPUTS_IMAGE must be one image reference.");
  const imageProbe = runSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  if (imageProbe.error || imageProbe.status !== 0) {
    unavailable(`configured image is not present locally: ${image}`);
  }

  const caRoot = requireSync("mkcert", ["-CAROOT"]).trim();
  const caPath = path.join(caRoot, "rootCA.pem");
  if (!fs.existsSync(caPath) || !fs.lstatSync(caPath).isFile()) {
    unavailable("mkcert root CA is unavailable; run devrouter tls install.");
  }

  return {
    candidate,
    candidateSha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
    caPath,
    dockerVersion: requireSync("docker", ["version", "--format", "{{.Server.Version}}"]),
    devsyVersion: requireSync("devsy", ["--version"]),
    image,
    imageId: requireSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"]),
  };
}

function renderServer(fixture: Fixture): string {
  return [
    '"use strict";',
    'const http = require("node:http");',
    `const fixture = ${JSON.stringify(fixture.id)};`,
    'const variant = process.env.DEVROUTER_RUNTIME_VARIANT || "default";',
    "const probe = process.env.DEVROUTER_HOST_PORT_PROBE || null;",
    "const server = http.createServer((request, response) => {",
    '  response.writeHead(200, { "content-type": "application/json" });',
    "  response.end(JSON.stringify({",
    "    fixture,",
    "    variant,",
    "    probe,",
    "    pid: process.pid,",
    "    path: request.url,",
    "  }));",
    "});",
    'server.listen(3000, "0.0.0.0");',
    "",
  ].join("\n");
}

function renderPortServer(fixture: Fixture): string {
  return [
    '"use strict";',
    'const http = require("node:http");',
    `const fixture = ${JSON.stringify(fixture.id)};`,
    "const server = http.createServer((request, response) => {",
    '  response.writeHead(200, { "content-type": "application/json" });',
    "  response.end(JSON.stringify({ fixture, pid: process.pid, port: 8080, path: request.url }));",
    "});",
    'server.listen(8080, "0.0.0.0");',
    "",
  ].join("\n");
}

function renderAdapter(): string {
  return [
    "#!/usr/bin/env bash",
    "# devrouter:managed devcontainer",
    "set -euo pipefail",
    ': "${DEVROUTER_PROCESS_HELPER:?Run devrouter ensure to start this managed application process.}"',
    '"$DEVROUTER_PROCESS_HELPER" ensure \\',
    "  --name app \\",
    "  --match 'node server.js' \\",
    "  -- node server.js",
    "",
  ].join("\n");
}

function writeFixture(root: string, token: string, role: "a" | "b", image: string): Fixture {
  const id = `runtime-inputs-${token}-${role}`;
  const checkout = path.join(root, id);
  fs.mkdirSync(checkout);
  const fixture: Fixture = {
    role,
    id,
    checkout,
    routeHost: `${id}.localhost`,
    routeUrl: `https://${id}.localhost`,
    attempted: false,
  };
  const devcontainer = path.join(checkout, ".devcontainer");
  fs.mkdirSync(devcontainer);

  fs.writeFileSync(
    path.join(checkout, ".gitignore"),
    [
      ".devcontainer/devcontainer.devrouter.json",
      ".devcontainer/docker-compose.devrouter-network.yml",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(checkout, ".devrouter.yml"),
    [
      "version: 1",
      "project:",
      `  name: ${id}`,
      "managedRuntime:",
      "  variants: [ci]",
      "  devcontainer:",
      "    baseServices: [portloop]",
      "    profileServices: []",
      "    hostPorts:",
      "      probe:",
      "        service: portloop",
      "        target: 8080",
      "  processes: [app]",
      "profiles:",
      "  full:",
      '    apps: ["*"]',
      '    processes: ["*"]',
      "    default: true",
      "apps:",
      "  - name: web",
      `    host: ${fixture.routeHost}`,
      "    protocol: http",
      "    runtime: proxy",
      `    upstream: ${id}-app:3000`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(devcontainer, "devcontainer.json"),
    `${JSON.stringify(
      {
        name: id,
        dockerComposeFile: "docker-compose.yml",
        service: "app",
        workspaceFolder: WORKSPACE_FOLDER,
        runServices: ["app", "portloop"],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(devcontainer, "docker-compose.yml"),
    [
      "services:",
      "  app:",
      `    image: ${JSON.stringify(image)}`,
      "    init: true",
      "    command: sleep infinity",
      `    working_dir: ${WORKSPACE_FOLDER}`,
      "    volumes:",
      `      - ..:${WORKSPACE_FOLDER}`,
      "    networks:",
      "      devnet:",
      "        aliases:",
      `          - ${id}-app`,
      "  portloop:",
      `    image: ${JSON.stringify(image)}`,
      "    init: true",
      "    command: [node, port-server.js]",
      "    working_dir: /runtime",
      "    volumes:",
      "      - ../port-server.js:/runtime/port-server.js:ro",
      "    ports:",
      "      - target: 8080",
      "        host_ip: 127.0.0.1",
      "        protocol: tcp",
      "    networks:",
      "      devnet:",
      "",
      "networks:",
      "  devnet:",
      "    external: true",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(devcontainer, "post-start.sh"), renderAdapter(), { mode: 0o755 });
  fs.writeFileSync(path.join(checkout, "server.js"), renderServer(fixture));
  fs.writeFileSync(path.join(checkout, "port-server.js"), renderPortServer(fixture));
  return fixture;
}

function initializeCheckout(fixture: Fixture): void {
  requireSync("git", ["-C", fixture.checkout, "init", "-q", "-b", "main"], "git init");
  requireSync("git", ["-C", fixture.checkout, "config", "user.email", "fixture@devrouter.invalid"]);
  requireSync("git", ["-C", fixture.checkout, "config", "user.name", "devrouter-runtime-inputs"]);
  requireSync("git", ["-C", fixture.checkout, "add", "--", "."]);
  requireSync("git", ["-C", fixture.checkout, "commit", "-qm", "synthetic runtime inputs fixture"]);
  assert.equal(
    requireSync("git", ["-C", fixture.checkout, "status", "--porcelain"]),
    "",
    "synthetic checkout is not clean",
  );
}

function runCandidate(candidate: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let streamed = 0;
    let finished = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const child: ChildProcess = spawn(process.execPath, [candidate, ...args], {
      cwd: path.dirname(candidate),
      env: commandEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      stderr = (stderr + value).slice(-MAX_STREAMED_STDERR);
      if (streamed < MAX_STREAMED_STDERR) {
        const visible = value.slice(0, MAX_STREAMED_STDERR - streamed);
        process.stderr.write(visible);
        streamed += visible.length;
      }
    });
    child.once("error", (error) => {
      finished = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code) => {
      finished = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ args, exitCode: code, timedOut, stdout, stderrTail: stderr });
    });
  });
}

function candidateSuccess(result: CommandResult, label: string): string {
  assert.equal(result.timedOut, false, `${label} exceeded its bound`);
  assert.equal(
    result.exitCode,
    0,
    `${label} failed${result.stderrTail ? `: ${truncate(result.stderrTail)}` : ""}`,
  );
  return result.stdout;
}

function docker(args: string[], timeout = 60_000): string {
  return requireSync("docker", args, `docker ${args[0]}`, timeout);
}

function containerIds(service: string, project: string): string[] {
  return docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function oneContainer(service: string, project: string): string {
  const ids = containerIds(service, project);
  assert.equal(ids.length, 1, `${service} must have exactly one retained container`);
  return ids[0];
}

function containerInspect(container: string, format: string): string {
  return docker(["inspect", "--format", format, container]);
}

function assertContainerShape(
  fixture: Fixture,
  imageId: string,
): { app: string; portloop: string } {
  assert.ok(fixture.composeProject, `${fixture.id} has no Compose project`);
  const app = oneContainer("app", fixture.composeProject as string);
  const portloop = oneContainer("portloop", fixture.composeProject as string);
  for (const container of [app, portloop]) {
    assert.equal(containerInspect(container, "{{.Image}}"), imageId, "fixture image changed");
    assert.equal(containerInspect(container, "{{.HostConfig.Init}}"), "true", "init must be true");
  }
  const mounts = JSON.parse(containerInspect(app, "{{json .Mounts}}")) as unknown;
  const mounted = arrayField(mounts, "app mounts").some((entry) => {
    const mount = asObject(entry);
    return (
      mount?.Type === "bind" &&
      mount.Destination === WORKSPACE_FOLDER &&
      typeof mount.Source === "string" &&
      fs.realpathSync(mount.Source) === fixture.checkout
    );
  });
  assert.ok(mounted, "app container does not bind-mount the exact checkout");
  return { app, portloop };
}

function providerWorkspace(fixture: Fixture): JsonObject {
  const output = requireSync(
    "devsy",
    ["workspace", "list", "--result-format", "json", "--skip-pro"],
    "devsy workspace list",
  );
  const parsed: unknown = JSON.parse(output);
  const entries = arrayField(parsed, "devsy workspace list");
  const matches = entries.filter((entry) => {
    const source = asObject(asObject(entry)?.source);
    return source?.localFolder === fixture.checkout;
  });
  assert.equal(matches.length, 1, `Devsy must own one workspace for ${fixture.checkout}`);
  return objectField(matches[0], "Devsy workspace");
}

function captureFixtureOwnership(fixture: Fixture): void {
  try {
    const provider = providerWorkspace(fixture);
    fixture.devpodId = stringField(provider.id, "provider id");
    const ids = docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project.working_dir=${fixture.checkout}/.devcontainer`,
      "--filter",
      "label=com.docker.compose.service=app",
    ])
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(ids.length, 1, "fixture must have one exact app service");
    const mounts = arrayField(JSON.parse(containerInspect(ids[0], "{{json .Mounts}}")), "mounts");
    assert.ok(
      mounts.some((entry) => {
        const mount = asObject(entry);
        return (
          mount?.Type === "bind" &&
          mount.Source === fixture.checkout &&
          mount.Destination === WORKSPACE_FOLDER
        );
      }),
      "fixture app must mount the exact checkout",
    );
    fixture.composeProject = stringField(
      containerInspect(ids[0], '{{index .Config.Labels "com.docker.compose.project"}}'),
      "Compose project",
    );
    fixture.appContainer = ids[0];
    fixture.portContainer = oneContainer("portloop", fixture.composeProject);
  } catch {
    // A provider failure may precede container creation; finalization still attempts stop.
  }
}

function providerStatus(devpodId: string): string {
  const output = requireSync(
    "devsy",
    ["workspace", "status", devpodId, "--result-format", "json", "--timeout", "30s"],
    "devsy workspace status",
  );
  const payload = parseObjectJson(output, "devsy workspace status");
  assert.equal(payload.id, devpodId, "Devsy status returned another workspace");
  return stringField(payload.state, "Devsy state");
}

async function ensureFixture(
  fixture: Fixture,
  candidate: string,
  imageId: string,
  variant?: "ci",
): Promise<{ payload: JsonObject; appContainer: string }> {
  if (!fixture.attempted) {
    fixture.attempted = true;
  }
  const result = await runCandidate(candidate, [
    "ensure",
    fixture.checkout,
    ...(variant ? ["--variant", variant] : []),
    "--json",
  ]);
  captureFixtureOwnership(fixture);
  const payload = parseObjectJson(candidateSuccess(result, `ensure ${fixture.id}`), "ensure");
  fixture.devpodId = stringField(payload.devpodId, "ensure.devpodId");
  assert.equal(payload.repoPath, fixture.checkout, "ensure returned another checkout");
  assert.equal(payload.kind, "primary", "fixture checkout is not primary");
  assert.equal(payload.variant, variant || "default", "ensure selected another variant");
  assert.equal(payload.hostPortConflicts, undefined, "fixed host-port admission conflicted");

  const managed = objectField(payload.managedRuntime, "ensure.managedRuntime");
  assert.equal(managed.status, "ready", "managed runtime is not ready");
  assert.equal(managed.activeVariant, variant || "default", "active variant does not match");
  assert.equal(managed.profile, "full", "full profile was not selected");
  fixture.composeProject = stringField(managed.composeProject, "managedRuntime.composeProject");
  const provider = providerWorkspace(fixture);
  assert.equal(provider.id, fixture.devpodId, "provider identity does not match ensure");

  const urls = arrayField(payload.urls, "ensure.urls").filter(
    (value): value is string => typeof value === "string",
  );
  assert.equal(urls.length, 1, "the fixture must publish one HTTP route");
  assert.equal(urls[0].replace(/\/$/, ""), fixture.routeUrl, "unexpected HTTP route");

  const containers = assertContainerShape(fixture, imageId);
  fixture.portContainer = containers.portloop;
  return { payload, appContainer: containers.app };
}

function envReport(fixture: Fixture, candidate: string): JsonObject {
  const result = spawnSync(process.execPath, [candidate, "env", fixture.checkout, "--json"], {
    cwd: path.dirname(candidate),
    env: commandEnvironment,
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.error, undefined, "env could not start");
  assert.equal(result.status, 0, `env failed: ${truncate(String(result.stderr || ""))}`);
  return parseObjectJson(String(result.stdout || ""), "env");
}

function curlJson(
  url: string,
  caPath?: string,
): { ok: boolean; body?: JsonObject; status: number } {
  const args = [
    "--disable",
    "--globoff",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "8",
    "--noproxy",
    "*",
    ...(caPath ? ["--cacert", caPath] : []),
    url,
  ];
  const result = runSync("curl", args, 30_000);
  if (result.error || result.status !== 0) return { ok: false, status: result.status ?? -1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout || ""));
  } catch {
    return { ok: false, status: result.status };
  }
  const body = asObject(parsed);
  return { ok: body !== undefined, body, status: result.status };
}

function readRuntime(
  fixture: Fixture,
  candidate: string,
  expectedVariant: "default" | "ci",
): { pid: number; probePort: number; appContainer: string } {
  const report = envReport(fixture, candidate);
  assert.equal(report.repoPath, fixture.checkout, "env returned another checkout");
  assert.equal(report.workspace, null, "synthetic checkout is not primary");
  const app = arrayField(report.apps, "env.apps")
    .map((entry) => objectField(entry, "env app"))
    .find((entry) => entry.host === fixture.routeHost);
  assert.ok(app, "env did not report the fixture HTTP app");
  assert.equal(app?.active, true, "env route is inactive");
  assert.equal(app?.url, fixture.routeUrl, "env returned another route URL");

  const hostPorts = objectField(report.hostPorts, "env.hostPorts");
  const probe = objectField(hostPorts.probe, "env.hostPorts.probe");
  assert.equal(probe.status, "available", "probe host port is unavailable");
  const endpoint = objectField(probe.endpoint, "probe endpoint");
  assert.equal(endpoint.host, "127.0.0.1", "probe is not loopback-only");
  const probePort = numberField(endpoint.port, "probe port");

  assert.ok(fixture.composeProject, `${fixture.id} has no Compose project`);
  const appContainer = oneContainer("app", fixture.composeProject as string);
  const portContainer = oneContainer("portloop", fixture.composeProject as string);
  assert.equal(containerInspect(appContainer, "{{.State.Running}}"), "true");
  assert.equal(containerInspect(portContainer, "{{.State.Running}}"), "true");

  const direct = curlJson(`http://127.0.0.1:${probePort}/`);
  assert.ok(direct.ok, "probe endpoint did not return JSON");
  assert.equal(direct.body?.fixture, fixture.id, "probe returned another fixture");
  assert.equal(direct.body?.port, 8080, "probe service listened on another port");

  const routed = curlJson(fixture.routeUrl, prerequisitesCaPath);
  assert.ok(routed.ok, "routed HTTPS endpoint did not return JSON");
  assert.equal(routed.body?.fixture, fixture.id, "route returned another fixture");
  assert.equal(routed.body?.variant, expectedVariant, "route exposed another variant");
  assert.equal(routed.body?.probe, String(probePort), "route did not expose the injected port");
  const pid = numberField(routed.body?.pid, "route pid");
  return { pid, probePort, appContainer };
}

let prerequisitesCaPath = "";

async function stopFixture(
  fixture: Fixture,
  candidate: string,
  requireChanged: boolean,
): Promise<JsonObject> {
  const result = await runCandidate(
    candidate,
    ["stop", fixture.checkout, "--json"],
    FINAL_STOP_TIMEOUT_MS,
  );
  const payload = parseObjectJson(
    candidateSuccess(result, `stop ${fixture.id}`),
    `stop ${fixture.id}`,
  );
  assert.equal(payload.repoPath, fixture.checkout, "stop returned another checkout");
  assert.equal(payload.kind, "primary", "stop returned another checkout kind");
  if (requireChanged) {
    assert.equal(payload.stopped, true, "first stop did not report a provider stop");
    assert.ok(numberField(payload.freedRoutes, "stop.freedRoutes") >= 1, "stop freed no route");
  }
  return payload;
}

function routeAbsent(fixture: Fixture, candidate: string): boolean {
  const env = envReport(fixture, candidate);
  const app = arrayField(env.apps, "env.apps")
    .map((entry) => objectField(entry, "env app"))
    .find((entry) => entry.host === fixture.routeHost);
  assert.ok(app, "stopped checkout lost its configured app report");
  assert.equal(app?.active, false, "stopped checkout still reports an active route");

  const result = spawnSync(process.execPath, [candidate, "ls", "--json"], {
    cwd: path.dirname(candidate),
    env: commandEnvironment,
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.error, undefined, "devrouter ls could not start");
  assert.equal(result.status, 0, "devrouter ls failed");
  assert.equal(
    String(result.stdout || "").includes(fixture.routeHost),
    false,
    "devrouter ls still contains the stopped route",
  );
  assert.equal(
    curlJson(fixture.routeUrl, prerequisitesCaPath).ok,
    false,
    "stopped route still answers",
  );
  return true;
}

function projectContainers(
  project: string,
): Array<{ id: string; running: boolean; status: string }> {
  const ids = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.map((id) => {
    const facts = containerInspect(id, "{{.State.Running}} {{.State.Status}}").split(" ");
    return { id, running: facts[0] === "true", status: facts[1] || "unknown" };
  });
}

async function finalize(
  attempted: Fixture[],
  candidate: string,
): Promise<{ ok: boolean; stops: JsonObject[] }> {
  const stops: JsonObject[] = [];
  let ok = true;
  for (const fixture of attempted) {
    const record: JsonObject = { checkout: fixture.checkout };
    try {
      record.stop = await stopFixture(fixture, candidate, false);
    } catch (error) {
      record.stopError = error instanceof Error ? error.message : String(error);
      ok = false;
    }

    try {
      const provider = providerWorkspace(fixture);
      const id = stringField(provider.id, "provider id");
      const state = providerStatus(id);
      record.provider = { id, state, sourcePath: fixture.checkout };
      if (state !== "Stopped") ok = false;
    } catch (error) {
      record.providerError = error instanceof Error ? error.message : String(error);
      ok = false;
    }

    try {
      assert.ok(fixture.composeProject, "missing Compose project");
      const containers = projectContainers(fixture.composeProject as string);
      record.containers = containers;
      if (containers.length === 0 || containers.some((entry) => entry.running)) ok = false;
      if (
        fixture.appContainer &&
        containerInspect(fixture.appContainer, "{{.State.Running}}") !== "false"
      ) {
        ok = false;
      }
    } catch (error) {
      record.containerError = error instanceof Error ? error.message : String(error);
      ok = false;
    }

    try {
      record.routeAbsent = routeAbsent(fixture, candidate);
    } catch (error) {
      record.routeError = error instanceof Error ? error.message : String(error);
      ok = false;
    }
    stops.push(record);
  }
  return { ok, stops };
}

async function main(): Promise<void> {
  const sourceRoot = path.resolve(__dirname, "..");
  const required = prerequisites(sourceRoot);
  prerequisitesCaPath = required.caPath;

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-runtime-inputs-")));
  assert.equal(fs.realpathSync(root), root, "temporary root is not canonical");
  const token = randomUUID().replaceAll("-", "").slice(0, 8);
  const fixtures = [
    writeFixture(root, token, "a", required.image),
    writeFixture(root, token, "b", required.image),
  ];
  for (const fixture of fixtures) {
    assert.equal(fs.realpathSync(fixture.checkout), fixture.checkout);
    initializeCheckout(fixture);
  }

  const attempted: Fixture[] = [];
  const observations: JsonObject = {};
  let failure: unknown;

  try {
    const first = fixtures[0];
    const neighbour = fixtures[1];
    attempted.push(first);
    const firstDefault = await ensureFixture(first, required.candidate, required.imageId);
    first.appContainer = firstDefault.appContainer;
    const firstInitial = readRuntime(first, required.candidate, "default");

    attempted.push(neighbour);
    const neighbourDefault = await ensureFixture(neighbour, required.candidate, required.imageId);
    neighbour.appContainer = neighbourDefault.appContainer;
    const neighbourInitial = readRuntime(neighbour, required.candidate, "default");
    const firstStillInitial = readRuntime(first, required.candidate, "default");
    assert.notEqual(
      firstInitial.probePort,
      neighbourInitial.probePort,
      "probe ports must be distinct",
    );
    assert.equal(firstStillInitial.appContainer, firstInitial.appContainer);

    const ci = await ensureFixture(first, required.candidate, required.imageId, "ci");
    const firstCi = readRuntime(first, required.candidate, "ci");
    assert.equal(
      ci.appContainer,
      firstInitial.appContainer,
      "CI variant replaced the app container",
    );
    assert.notEqual(firstCi.pid, firstInitial.pid, "CI variant did not replace the helper PID");
    assert.equal(
      oneContainer("app", neighbour.composeProject as string),
      neighbourInitial.appContainer,
      "neighbour container changed during the CI variant",
    );
    assert.deepEqual(readRuntime(neighbour, required.candidate, "default"), neighbourInitial);

    const ciRepeat = await ensureFixture(first, required.candidate, required.imageId, "ci");
    const firstCiRepeat = readRuntime(first, required.candidate, "ci");
    assert.equal(ciRepeat.appContainer, firstInitial.appContainer);
    assert.equal(firstCiRepeat.pid, firstCi.pid, "unchanged CI ensure replaced the helper PID");
    assert.equal(
      firstCiRepeat.probePort,
      firstCi.probePort,
      "unchanged CI ensure moved the probe port",
    );

    const resumedDefault = await ensureFixture(first, required.candidate, required.imageId);
    const firstResumed = readRuntime(first, required.candidate, "default");
    assert.equal(resumedDefault.appContainer, firstInitial.appContainer);
    assert.notEqual(firstResumed.pid, firstCi.pid, "omitted variant did not restore default");
    assert.equal(
      oneContainer("app", neighbour.composeProject as string),
      neighbourInitial.appContainer,
      "neighbour container changed during default restoration",
    );

    observations.firstInitial = firstInitial;
    observations.neighbourInitial = neighbourInitial;
    observations.firstCi = firstCi;
    observations.firstCiRepeat = firstCiRepeat;
    observations.firstResumed = firstResumed;

    await stopFixture(first, required.candidate, true);
    assert.equal(containerInspect(first.appContainer, "{{.State.Running}}"), "false");
    assert.equal(providerStatus(first.devpodId as string), "Stopped");
    assert.equal(routeAbsent(first, required.candidate), true);
    const neighbourAfterStop = readRuntime(neighbour, required.candidate, "default");
    assert.equal(neighbourAfterStop.appContainer, neighbourInitial.appContainer);
    assert.deepEqual(neighbourAfterStop, neighbourInitial);
    observations.neighbourAfterFirstStop = neighbourAfterStop;
  } catch (error) {
    failure = error;
  }

  const finalized = await finalize(attempted, required.candidate);
  if (!finalized.ok && failure === undefined) {
    failure = new Error("final exact stop, provider, container, or route proof failed");
  }

  const pass = failure === undefined && finalized.ok;
  const receipt = {
    schemaVersion: 1,
    status: pass ? "pass" : "fail",
    pass,
    source: {
      root,
      candidate: required.candidate,
      candidateSha256: required.candidateSha256,
      node: process.version,
    },
    prerequisites: {
      docker: required.dockerVersion,
      devsy: required.devsyVersion,
      image: required.image,
      imageId: required.imageId,
      caPath: required.caPath,
    },
    fixtures: attempted.map((fixture) => ({
      role: fixture.role,
      checkout: fixture.checkout,
      routeHost: fixture.routeHost,
      attempted: fixture.attempted,
      devpodId: fixture.devpodId || null,
      composeProject: fixture.composeProject || null,
      appContainer: fixture.appContainer || null,
      portContainer: fixture.portContainer || null,
    })),
    observations,
    finalStops: finalized.stops,
    failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
    retained: {
      root,
      checkouts: fixtures.map((fixture) => fixture.checkout),
      image: required.image,
      data: "retained; no runtime or fixture deletion was requested",
    },
  };
  const evidencePath = path.join(root, "evidence.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: receipt.status,
        evidencePath,
        retainedRoot: root,
        failure: receipt.failure,
      },
      null,
      2,
    )}\n`,
  );
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    "Runtime-input qualification failed: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
