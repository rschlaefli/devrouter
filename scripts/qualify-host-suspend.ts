/**
 * Qualify a real host suspend (roadmap Q20 / RF09 live cell).
 *
 * A laptop suspends, and the product has to treat the wake as a continuity
 * break instead of continuing a session it can no longer vouch for. Source
 * tests cover that contract with fake clocks; a real host suspend has never
 * been observed, so the cell runs in two bounded phases because the suspend
 * itself belongs to the operator:
 *
 *   prepare  brings up a real routed Docker fixture through the machine's own
 *            Traefik and TLS stack, starts the shipped controller with an
 *            isolated home over a synthetic provider fixture, acquires one
 *            session, and records the pre-suspend state together with the
 *            machine's own power log. The session stays live because the
 *            fixture keeps renewing it, exactly as a watching consumer would,
 *            until the suspend interrupts that heartbeat. It then prints how
 *            to suspend.
 *   verify   reads that record, requires a real Sleep/Wake pair from the
 *            machine's own power log that happened after prepare, and only then
 *            asserts what the wake produced: the pre-suspend session was
 *            invalidated rather than continued, the protection grace left
 *            continuity-unknown, and the published route still serves the token
 *            the fixture recorded before the host slept.
 *
 * The two halves stay separate on purpose. The controller half uses an isolated
 * home and synthetic providers, so it observes the product's own clock
 * continuity without depending on a real container runtime. The environment
 * half uses the machine's real Traefik, TLS trust and Docker daemon, so a
 * suspend that ended a container or wedged a route is visible instead of hidden
 * behind a stub.
 *
 * Exit codes: 0 every assertion held, 1 an assertion failed, 3 no suspend was
 * observed or a prerequisite is unavailable. A skip is not a pass, so a caller
 * recording acceptance must reject 3 instead of reading it as success.
 *
 * Recorded limitation: capacity-window clearing on a clock discontinuity stays
 * covered by capacity-accounting.test.ts, because driving one live admission
 * across the suspend would need a capacity fixture this cell does not. The
 * receipt names that boundary instead of implying the whole row is live.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createReliabilityState } from "../src/core/reliability-contract";
import type { ReliabilityOperationRecord } from "../src/core/reliability-operation-store";

const ROOT = process.cwd();
const NODE = process.execPath;
const DIST = process.env.DR_HS_DIST ?? path.join(ROOT, "dist", "devrouter.js");
// A short work root keeps the controller's Unix socket path inside the platform
// bound; the controller home lives under it, never under the user's own home.
const WORK = process.env.DR_HS_WORK ?? "/private/tmp/dr-host-suspend";
const CHECKPOINT = path.join(WORK, "checkpoint.json");
const RECEIPT = path.join(WORK, "receipt.json");
const LIVE_HOST = "host-suspend.localhost";
const LIVE_APP = "web";
// Traefik's docker router namespace is machine-global, so the fixture claims its
// own router id instead of colliding with another checkout's "web" app.
const LIVE_ROUTER = "hostsuspend-fixture";
const SESSION = "suspend";

type PowerEvent = { kind: "sleep" | "wake"; atMs: number; line: string };

type Checkpoint = {
  schema: "devrouter.host-suspend.checkpoint.v1";
  preparedAtMs: number;
  preparedAt: string;
  revision: string;
  distSha256: string;
  home: string;
  controller: {
    pid: number;
    socket: string;
    checkout: string;
    store: string;
    epoch: number;
    generation: string;
    session: string;
  };
  protection: {
    measuredAtMs: number;
    continuity: string;
    graceRemainingMs: number;
    liveConsumers: number;
  };
  live: {
    repo: string;
    url: string;
    container: string;
    token: string;
    composeFiles: string;
  };
  powerBefore: string[];
};

const failures: string[] = [];
const facts: string[] = [];

function skip(reason: string): never {
  process.stdout.write(`host-suspend qualification not run: ${reason}\n`);
  process.exit(3);
}

function fail(reason: string): never {
  process.stderr.write(`FAIL: ${reason}\n`);
  process.exit(1);
}

function check(condition: boolean, description: string) {
  if (condition) facts.push(description);
  else failures.push(description);
}

function command(
  name: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; allowFailure?: boolean } = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(name, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    // The machine's power log is the one command here whose output runs past
    // the 1 MiB spawn default, so the bound is raised for every fixture call.
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`${name} ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  return result;
}

function cli(args: string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}) {
  return command(NODE, [DIST, ...args], options);
}

function cliJson(args: string[], env?: NodeJS.ProcessEnv): Record<string, unknown> {
  const result = cli([...args, "--json"], env ? { env } : {});
  // Commands print either one compact line or one indented document, so the
  // document starts at the first line that opens a JSON value.
  const lines = result.stdout.split("\n");
  const start = lines.findIndex((line) => /^[[{]/.test(line.trim()));
  const text = start === -1 ? "" : lines.slice(start).join("\n").trim();
  if (!text) throw new Error(`devrouter ${args.join(" ")} printed no result.`);
  return JSON.parse(text) as Record<string, unknown>;
}

type Binding = { session: string; store: string; epoch: number; generation: string };

function protectionArgs(binding: Binding): string[] {
  return [
    "controller",
    "protection-status",
    "--session",
    binding.session,
    "--store",
    binding.store,
    "--epoch",
    String(binding.epoch),
    "--generation",
    binding.generation,
  ];
}

/** The controller's own durable snapshot is the product state behind its CLI. */
function controllerSnapshot(home: string): {
  store?: string;
  epoch?: number;
  retainedSessions?: Array<{ id?: string; generation?: string; reason?: string }>;
  events?: Array<{ session?: string; generation?: string; kind?: string }>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".config", "devrouter", "controller", "snapshot.json"), "utf8"),
  ) as never;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The controller home is a fixture, so its reliability journal is written
 * straight into that home. The product's own writer resolves its directory from
 * the harness process home and would place the record in the operator's real
 * machine state, while the record shape still comes from the product contract
 * so the fixture controller reads exactly what it expects.
 */
function writeFixtureJournal(home: string, checkout: string) {
  const directory = path.join(home, ".config", "devrouter", "reliability");
  const file = path.join(directory, `${sha256(checkout)}.json`);
  if (!file.startsWith(`${home}${path.sep}`))
    fail(`refusing to write a fixture journal outside ${home}.`);
  const record: ReliabilityOperationRecord = {
    version: 1,
    identity: { repoPath: checkout, workspace: "fixture", provider: "devsy" },
    revision: 0,
    state: {
      ...createReliabilityState(sha256(checkout), 0, "manual"),
      desired: "running",
      phase: "stable",
    },
    worker: null,
    effectSequence: 0,
    outcome: null,
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** The machine's own power log is the only accepted suspend evidence. */
function powerEvents(): PowerEvent[] {
  const result = command("/usr/bin/pmset", ["-g", "log"], { allowFailure: true });
  const events: PowerEvent[] = [];
  for (const line of `${result.stdout ?? ""}`.split("\n")) {
    const match =
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\s+(Sleep|Wake|DarkWake)\b/.exec(line);
    if (!match) continue;
    const [, day, time, zone, kind] = match;
    if (kind === "DarkWake") continue;
    const iso = `${day}T${time}${zone.slice(0, 3)}:${zone.slice(3)}`;
    const atMs = Date.parse(iso);
    if (!Number.isFinite(atMs)) continue;
    events.push({
      kind: kind === "Sleep" ? "sleep" : "wake",
      atMs,
      line: line.trim().slice(0, 200),
    });
  }
  return events;
}

function lastSuspend(events: PowerEvent[], afterMs: number) {
  let open: PowerEvent | undefined;
  let pair: { sleep: PowerEvent; wake: PowerEvent } | undefined;
  for (const event of events) {
    if (event.atMs < afterMs) continue;
    if (event.kind === "sleep") open = event;
    else if (open) {
      pair = { sleep: open, wake: event };
      open = undefined;
    }
  }
  return pair;
}

function liveRouteUrl(): string {
  const listing = cliJson(["ls"]) as { routes?: Array<{ hosts?: string[]; urls?: string[] }> };
  for (const route of listing.routes ?? [])
    if ((route.hosts ?? []).includes(LIVE_HOST)) return (route.urls ?? [])[0] ?? "";
  return "";
}

/** The fixture's own compose working directory is its machine identity. */
function liveLabelFilter(): string {
  return `label=com.docker.compose.project.working_dir=${path.join(WORK, "live")}`;
}

function liveContainers(): string[] {
  const result = command("docker", ["ps", "-aq", "--filter", liveLabelFilter()], {
    allowFailure: true,
  });
  return (result.stdout ?? "").trim().split("\n").filter(Boolean);
}

function liveContainer(): string {
  const result = command(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      liveLabelFilter(),
      "--filter",
      "label=com.docker.compose.service=web",
    ],
    { allowFailure: true },
  );
  return (result.stdout ?? "").trim().split("\n").filter(Boolean)[0] ?? "";
}

function liveComposeFiles(container: string): string {
  if (!container) return "";
  const result = command(
    "docker",
    [
      "inspect",
      "-f",
      '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
      container,
    ],
    { allowFailure: true },
  );
  return (result.stdout ?? "").trim();
}

function fetchRoute(url: string, ca: string): { ok: boolean; body: string } {
  const result = command("curl", ["-fsS", "--max-time", "5", "--cacert", ca, url], {
    allowFailure: true,
  });
  return { ok: result.status === 0, body: `${result.stdout ?? ""}`.trim() };
}

function releaseLiveFixture(checkpoint: Checkpoint) {
  cli(["app", "rm", LIVE_APP, "--repo", checkpoint.live.repo, "--keep-config"], {
    allowFailure: true,
  });
  const files = checkpoint.live.composeFiles;
  if (!files) return;
  const args: string[] = [];
  for (const file of files.split(",").filter(Boolean)) args.push("-f", file);
  if (!args.length) return;
  command("docker", ["compose", ...args, "down", "--volumes", "--remove-orphans"], {
    allowFailure: true,
  });
}

/** The session lease only lasts 30 seconds, so a live consumer must renew. */
const HEARTBEAT_MS = 10_000;

/**
 * Renewal runs in its own detached process: the operator suspends minutes after
 * prepare, so without this heartbeat the lease would simply expire long before
 * the sleep and the wake would prove nothing about continuity. The renewer
 * stops on the first refused renewal, which is what a client sees after a wake.
 */
const HEARTBEAT_SOURCE = [
  "const { execFileSync } = require('node:child_process');",
  "const spec = JSON.parse(process.env.DR_HS_RENEW);",
  "const args = [",
  "  spec.dist, 'controller', 'renew',",
  "  '--session', spec.session, '--store', spec.store,",
  "  '--epoch', String(spec.epoch), '--generation', spec.generation, '--json',",
  "];",
  "const env = { HOME: spec.home, PATH: spec.path, LC_ALL: 'C', NODE_OPTIONS: '', DOCKER_HOST: spec.dockerHost };",
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
  "process.on('SIGTERM', () => process.exit(0));",
  "(async () => {",
  "  for (;;) {",
  "    try {",
  "      execFileSync(spec.node, args, { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });",
  "      process.stdout.write(new Date().toISOString() + ' renewed ' + spec.session + '\\n');",
  "    } catch (error) {",
  "      const cause = String((error && error.message) || error).split('\\n')[0];",
  "      process.stdout.write(new Date().toISOString() + ' renew refused: ' + cause + '\\n');",
  "      process.exit(0);",
  "    }",
  "    await sleep(spec.intervalMs);",
  "  }",
  "})();",
].join("\n");

function startHeartbeat(binding: Binding, home: string, bin: string): void {
  const log = fs.openSync(path.join(WORK, "heartbeat.log"), "a");
  const child = spawn(NODE, ["-e", HEARTBEAT_SOURCE, "devrouter-host-suspend-heartbeat", DIST], {
    env: {
      ...process.env,
      DR_HS_RENEW: JSON.stringify({
        node: NODE,
        dist: DIST,
        home,
        path: `${bin}:/usr/bin:/bin`,
        dockerHost: `unix://${WORK}/absent.sock`,
        session: binding.session,
        store: binding.store,
        epoch: binding.epoch,
        generation: binding.generation,
        intervalMs: HEARTBEAT_MS,
      }),
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  const pid = child.pid ?? 0;
  if (!pid) fail("the fixture heartbeat did not start.");
  fs.writeFileSync(path.join(WORK, "heartbeat.pid"), String(pid));
}

async function stopProcess(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process stopped between the probe and the signal.
  }
}

/** A recorded pid is signalled only after its command line proves it is ours. */
async function stopOwnedPid(pidFile: string, marker: string[]) {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  const probe = command("/bin/ps", ["-o", "command=", "-p", String(pid)], { allowFailure: true });
  const line = `${probe.stdout ?? ""}`;
  if (!marker.every((part) => line.includes(part))) return;
  await stopProcess(pid);
}

/**
 * A half-finished run owns this scratch root, so preparing again clears it. The
 * recorded pids are only signalled after their command lines prove they are
 * this cell's processes; a reused pid never becomes a kill target.
 */
async function resetWorkRoot() {
  if (!fs.existsSync(WORK)) return;
  if (!path.basename(WORK).startsWith("dr-host-suspend"))
    fail(`refusing to reuse ${WORK}; this cell only owns its own scratch root.`);
  await stopOwnedPid(path.join(WORK, "heartbeat.pid"), ["devrouter-host-suspend-heartbeat", DIST]);
  await stopOwnedPid(path.join(WORK, "controller.pid"), [DIST, "controller run"]);
  const live = path.join(WORK, "live");
  if (fs.existsSync(live))
    cli(["app", "rm", LIVE_APP, "--repo", live, "--keep-config"], { allowFailure: true });
  const stale = liveContainers();
  const files = stale.length ? liveComposeFiles(stale[0]) : "";
  if (files) {
    const args: string[] = [];
    for (const file of files.split(",").filter(Boolean)) args.push("-f", file);
    if (args.length)
      command("docker", ["compose", ...args, "down", "--volumes", "--remove-orphans"], {
        allowFailure: true,
      });
  } else for (const id of stale) command("docker", ["rm", "-f", id], { allowFailure: true });
  for (const child of [
    "home",
    "bin",
    "control",
    "live",
    "controller.pid",
    "controller.log",
    "heartbeat.pid",
    "heartbeat.log",
    "provider-calls.jsonl",
    "unexpected-provider-call.jsonl",
  ])
    fs.rmSync(path.join(WORK, child), { recursive: true, force: true });
}

/**
 * Synthetic providers for the controller half. They answer exactly the calls
 * the observation resolver needs, and any other call is recorded and refused so
 * a drifting fixture fails instead of silently accepting a wider surface.
 */
function writeStubProviders(
  bin: string,
  state: {
    checkout: string;
    composeDirectory: string;
    composeFile: string;
    calls: string;
    mutations: string;
  },
) {
  const snapshots = ["app", "db"].map((service, index) => ({
    id: (index ? "b" : "a").repeat(64),
    state: {
      Running: true,
      Status: "running",
      Paused: false,
      Restarting: false,
      Dead: false,
      StartedAt: "2026-09-08T00:00:00Z",
    },
    labels: {
      "com.docker.compose.project": "fixture",
      "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": state.composeDirectory,
      "com.docker.compose.project.config_files": state.composeFile,
      "com.docker.compose.config-hash": "c".repeat(64),
    },
    mounts: [{ Type: "bind", Source: state.checkout, Destination: "/workspace" }],
    networks: {},
  }));
  for (const provider of ["devpod", "devsy", "docker", "curl"]) {
    const script = `#!${NODE}
const fs=require('node:fs'); const args=process.argv.slice(2); const provider=${JSON.stringify(provider)};
fs.appendFileSync(${JSON.stringify(state.calls)},JSON.stringify({provider,operation:args[0]})+'\\n');
const snapshots=${JSON.stringify(snapshots)};
if(provider==='devpod' && JSON.stringify(args)===JSON.stringify(['list','--output','json','--skip-pro'])) process.stdout.write('[]');
else if(provider==='devsy' && JSON.stringify(args)===JSON.stringify(['workspace','list','--result-format','json','--skip-pro'])) process.stdout.write(${JSON.stringify(JSON.stringify([{ id: "fixture", source: { localFolder: state.checkout } }]))});
else if(provider==='docker' && JSON.stringify(args)===JSON.stringify(['ps','-a','--no-trunc','--filter','label=com.docker.compose.project=fixture','--format','{{.ID}}'])) process.stdout.write(snapshots.map((x)=>x.id).join('\\n'));
else if(provider==='docker' && args[0]==='inspect' && args[1]==='--format' && JSON.stringify(args.slice(3))===JSON.stringify(snapshots.map((x)=>x.id))) process.stdout.write(snapshots.map((x)=>JSON.stringify(x)).join('\\n'));
else if(provider==='docker' && args[0]==='compose' && args[1]==='--project-name' && args[2]==='fixture' && args[3]==='--project-directory' && args[4]===${JSON.stringify(state.composeDirectory)} && JSON.stringify(args.slice(5))===JSON.stringify(['-f',${JSON.stringify(state.composeFile)},'config','--format','json'])) process.stdout.write('{}');
else if(provider==='docker' && args[0]==='compose' && args[1]==='--project-name' && args[2]==='fixture' && args[3]==='--project-directory' && args[4]===${JSON.stringify(state.composeDirectory)} && JSON.stringify(args.slice(5,-1))===JSON.stringify(['-f','-','config','--no-interpolate','--hash']) && ['app','db'].includes(args.at(-1))) { process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(args.at(-1)+' '+'c'.repeat(64))); }
else if(provider==='docker' && args[0]==='exec' && args[1]===snapshots[0].id && JSON.stringify(args.slice(2,7))===JSON.stringify(['timeout','--signal=KILL','2s','bash','-c']) && args[8]==='observer' && args[9]==='web' && args.length===10) process.stdout.write('123 456 fixture');
else if(provider==='curl' && JSON.stringify(args)===JSON.stringify(['--disable','--globoff','--silent','--show-error','--no-location','--noproxy','*','--output','/dev/null','--write-out','%{http_code}\\t%{content_type}','--max-time','2','http://web.fixture.localhost/health'])) process.stdout.write('200\\tapplication/json');
else { fs.appendFileSync(${JSON.stringify(state.mutations)},JSON.stringify({provider,args})+'\\n'); process.exit(1); }
`;
    fs.writeFileSync(path.join(bin, provider), script, { mode: 0o700 });
  }
}

/** Bring up the real routed fixture and wait for the machine's Traefik to serve it. */
async function startLiveFixture(live: string, ca: string) {
  const token = createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 32);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(
    path.join(live, ".devrouter.yml"),
    [
      "version: 1",
      "apps:",
      `  - name: ${LIVE_APP}`,
      `    host: ${LIVE_HOST}`,
      "    protocol: http",
      "    runtime: docker",
      "    docker:",
      "      service: web",
      "      internalPort: 8080",
      `      router: ${LIVE_ROUTER}`,
      "      composeFiles:",
      "        - docker-compose.yml",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(live, "docker-compose.yml"),
    [
      "services:",
      "  web:",
      "    image: busybox:1.36",
      "    environment:",
      `      SUSPEND_TOKEN: "${token}"`,
      "    command:",
      "      - sh",
      "      - -c",
      '      - mkdir -p /srv; printf %s "$${SUSPEND_TOKEN}" > /srv/index.html; exec httpd -f -p 8080 -h /srv',
      "",
    ].join("\n"),
  );
  command("git", ["init", "--quiet"], { cwd: live, allowFailure: true });
  cli(["app", "run", LIVE_APP, "--repo", live]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const url = liveRouteUrl();
    if (url && fetchRoute(url, ca).ok) return { token, url, container: liveContainer() };
    await delay(1_000);
  }
  throw new Error("the routed live fixture never answered on its published route.");
}

async function prepare() {
  if (process.platform !== "darwin") skip("this cell observes a macOS power log.");
  if (!fs.existsSync(DIST)) skip("build dist/devrouter.js first (pnpm build).");
  if (fs.existsSync(CHECKPOINT))
    fail(`a prepared run already exists at ${CHECKPOINT}; verify it before preparing another.`);
  if (command("/usr/bin/pmset", ["-g", "log"], { allowFailure: true }).status !== 0)
    skip("the macOS power log is unavailable.");
  if (command("docker", ["info"], { allowFailure: true }).status !== 0)
    skip("the Docker daemon is not reachable.");
  const ca = `${command("mkcert", ["-CAROOT"], { allowFailure: true }).stdout.trim()}/rootCA.pem`;
  if (!fs.existsSync(ca)) skip("the mkcert root CA is unavailable (run devrouter tls install).");

  await resetWorkRoot();
  fs.mkdirSync(WORK, { recursive: true });
  const home = path.join(WORK, "home");
  const bin = path.join(WORK, "bin");
  const control = path.join(WORK, "control");
  const checkout = path.join(control, "trees", "fixture");
  for (const directory of [home, bin, control]) fs.mkdirSync(directory, { recursive: true });

  const composeDirectory = path.join(checkout, ".devcontainer");
  const composeFile = path.join(composeDirectory, "compose.yml");
  const source = JSON.stringify({ service: "app", dockerComposeFile: "compose.yml" });
  command("git", ["init", "--quiet", control]);
  command("git", [
    "-C",
    control,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  // The worktree has to exist before anything is written inside it.
  command("git", ["-C", control, "worktree", "add", "-b", "fixture", checkout]);
  fs.mkdirSync(composeDirectory, { recursive: true });
  fs.writeFileSync(
    composeFile,
    "services:\n  app:\n    image: fixture\n  db:\n    image: fixture\n",
  );
  fs.writeFileSync(path.join(composeDirectory, "devcontainer.json"), source);
  fs.writeFileSync(path.join(composeDirectory, "devcontainer.devrouter.json"), source);
  const gitDir = command("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"]).stdout.trim();
  const common = path.join(control, ".git");
  fs.mkdirSync(path.join(common, "devrouter", "workspaces"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), "fixture\n");
  fs.writeFileSync(
    path.join(common, "devrouter", "workspaces", "fixture.json"),
    JSON.stringify({
      version: 1,
      workspace: "fixture",
      worktreePath: checkout,
      devpodId: "fixture",
    }),
  );
  fs.writeFileSync(
    path.join(checkout, ".devrouter.yml"),
    'version: 1\nmanagedRuntime:\n  devcontainer:\n    baseServices: [db]\n    profileServices: []\n  processes: [web]\nprofiles:\n  full:\n    apps: ["*"]\n    processes: ["*"]\n    default: true\napps:\n  - name: web\n    host: web.localhost\n    protocol: http\n    runtime: proxy\n    upstream: ${WORKSPACE}-web:3000\n    readiness:\n      path: /health\n',
  );
  const routerHome = path.join(home, ".config", "devrouter");
  const routeFile = path.join(routerHome, "host-routes-state.json");
  fs.mkdirSync(path.dirname(routeFile), { recursive: true });
  fs.writeFileSync(
    routeFile,
    JSON.stringify([
      {
        id: `${checkout}::web`,
        repoPath: checkout,
        workspace: "fixture",
        name: "web",
        host: "web.fixture.localhost",
        protocol: "http",
        mode: "proxy",
        upstreamHost: "fixture-web",
        port: 3000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  const stateFile = path.join(
    routerHome,
    "managed-runtime",
    `${sha256(`${checkout}\0fixture`)}.json`,
  );
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      repoPath: checkout,
      workspace: "fixture",
      devpodId: "fixture",
      composeProject: "fixture",
      profile: "full",
      desired: { apps: ["web"], services: [], processes: ["web"] },
      sourceConfigSha256: sha256(source),
      effectiveConfigSha256: sha256(source),
      status: "ready",
      updatedAt: new Date().toISOString(),
    }),
  );
  // Both the observation resolver and the protection evidence read this record.
  writeFixtureJournal(home, checkout);
  writeStubProviders(bin, {
    checkout,
    composeDirectory,
    composeFile,
    calls: path.join(WORK, "provider-calls.jsonl"),
    mutations: path.join(WORK, "unexpected-provider-call.jsonl"),
  });

  const controllerEnv = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    LC_ALL: "C",
    NODE_OPTIONS: "",
    DOCKER_HOST: `unix://${WORK}/absent.sock`,
  } satisfies NodeJS.ProcessEnv;
  const socket = path.join(home, ".config", "devrouter", "controller", "control.sock");
  const log = fs.openSync(path.join(WORK, "controller.log"), "a");
  const controller = spawn(NODE, [DIST, "controller", "run"], {
    env: controllerEnv,
    detached: true,
    stdio: ["ignore", log, log],
  });
  controller.unref();
  const pid = controller.pid ?? 0;
  if (!pid) fail("the fixture controller did not start.");
  fs.writeFileSync(path.join(WORK, "controller.pid"), String(pid));
  const socketDeadline = Date.now() + 10_000;
  let connected = false;
  while (Date.now() < socketDeadline && !connected) {
    if (fs.existsSync(socket)) {
      connected = await new Promise<boolean>((resolve) => {
        const probe = net.createConnection(socket);
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => {
          probe.destroy();
          resolve(false);
        });
      });
    }
    if (!connected) await delay(50);
  }
  if (!connected) fail(`the fixture controller never listened on ${socket}.`);

  // The live fixture comes up before the session is acquired: the lease only
  // lasts 30 seconds, so no provider work may sit between acquisition and the
  // pre-suspend reading that follows it.
  const { token, url, container } = await startLiveFixture(path.join(WORK, "live"), ca);
  const composeFiles = liveComposeFiles(container);
  if (!composeFiles) fail("the live fixture container carries no compose file set.");

  const observed = cliJson(
    [
      "controller",
      "observe",
      checkout,
      "--session",
      SESSION,
      "--profile",
      "full",
      "--require",
      "app:web",
    ],
    controllerEnv,
  ) as { result?: Binding };
  const binding = observed.result;
  if (
    !binding ||
    typeof binding.store !== "string" ||
    typeof binding.generation !== "string" ||
    !Number.isSafeInteger(binding.epoch)
  )
    fail("the controller session could not be acquired.");
  const status = cliJson(["controller", "status"], controllerEnv) as {
    result?: { sessions?: Array<{ id?: string }> };
  };
  if (!(status.result?.sessions ?? []).some((entry) => entry.id === SESSION))
    fail("the acquired session is absent from the controller snapshot.");

  // The last reading before the operator suspends also anchors the grace-window
  // comparison verify makes, so take it once everything else is in place and
  // keep its own timestamp: the checkpoint is written a heartbeat later.
  const protectionReadAtMs = Date.now();
  const protection = cliJson(protectionArgs(binding), controllerEnv) as {
    result?: Record<string, unknown>;
  };
  const protectionResult = protection.result ?? {};
  if (typeof protectionResult.continuity !== "string")
    fail("the fixture controller returned no protection reading before the suspend.");
  // The operator suspends minutes later, so the session needs the same live
  // heartbeat a watching consumer would send. One full interval proves the
  // heartbeat, not the just-issued lease, is what keeps it alive.
  startHeartbeat(binding, home, bin);
  await delay(HEARTBEAT_MS + 2_000);
  const heartbeatLog = fs.readFileSync(path.join(WORK, "heartbeat.log"), "utf8");
  if (!heartbeatLog.includes("renewed"))
    fail(`the fixture heartbeat produced no renewal: ${heartbeatLog.trim().slice(-200)}`);
  const checkpoint: Checkpoint = {
    schema: "devrouter.host-suspend.checkpoint.v1",
    preparedAtMs: Date.now(),
    preparedAt: new Date().toISOString(),
    revision: command("git", ["rev-parse", "HEAD"]).stdout.trim(),
    distSha256: fileSha256(DIST),
    home,
    controller: {
      pid,
      socket,
      checkout,
      store: String(binding.store),
      epoch: Number(binding.epoch),
      generation: String(binding.generation),
      session: SESSION,
    },
    protection: {
      measuredAtMs: protectionReadAtMs,
      continuity: String(protectionResult.continuity),
      graceRemainingMs: Number(protectionResult.graceRemainingMs),
      liveConsumers: Number(protectionResult.liveConsumers),
    },
    live: { repo: path.join(WORK, "live"), url, container, token, composeFiles },
    powerBefore: powerEvents()
      .slice(-4)
      .map((event) => event.line),
  };
  fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
  process.stdout.write(
    [
      `prepared at revision ${checkpoint.revision} (dist ${checkpoint.distSha256.slice(0, 8)}...)`,
      `fixture: ${checkpoint.live.url} serves ${token}`,
      `controller session '${SESSION}' is live in ${home}`,
      `protection before the suspend: ${checkpoint.protection.continuity}, ${checkpoint.protection.graceRemainingMs}ms of grace left`,
      "",
      "Suspend this Mac now (a clamshell or menu-bar sleep counts), wait at least a",
      "minute asleep, then resume it and run:",
      "  pnpm qualify:host-suspend verify",
      "",
    ].join("\n"),
  );
}

async function verify() {
  if (!fs.existsSync(CHECKPOINT))
    skip("no prepared run exists; run pnpm qualify:host-suspend first.");
  const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")) as Checkpoint;
  const ca = `${command("mkcert", ["-CAROOT"], { allowFailure: true }).stdout.trim()}/rootCA.pem`;
  const pair = lastSuspend(powerEvents(), checkpoint.preparedAtMs);
  if (!pair)
    skip("the machine's power log records no Sleep/Wake pair after this run was prepared.");
  const sleptSeconds = Math.round((pair.wake.atMs - pair.sleep.atMs) / 1000);
  facts.push(`the machine slept ${sleptSeconds}s between the recorded Sleep and Wake`);

  const controllerEnv = {
    HOME: checkpoint.home,
    PATH: `${path.join(WORK, "bin")}:/usr/bin:/bin`,
    LC_ALL: "C",
    NODE_OPTIONS: "",
    DOCKER_HOST: `unix://${WORK}/absent.sock`,
  } satisfies NodeJS.ProcessEnv;
  try {
    const binding = checkpoint.controller;
    const status = cliJson(["controller", "status"], controllerEnv) as {
      result?: { sessions?: Array<{ id?: string }> };
    };
    check(
      !(status.result?.sessions ?? []).some((entry) => entry.id === binding.session),
      "the pre-suspend session is gone from the controller snapshot",
    );
    const staleRenew = cli(
      [
        "controller",
        "renew",
        "--session",
        binding.session,
        "--store",
        binding.store,
        "--epoch",
        String(binding.epoch),
        "--generation",
        binding.generation,
      ],
      { env: controllerEnv, allowFailure: true },
    );
    check(staleRenew.status !== 0, "the pre-suspend generation cannot be renewed after the wake");
    check(
      cli(protectionArgs(binding), { env: controllerEnv, allowFailure: true }).status !== 0,
      "the pre-suspend generation cannot obtain protection evidence after the wake",
    );
    const snapshot = controllerSnapshot(checkpoint.home);
    check(
      snapshot.store === binding.store && snapshot.epoch === binding.epoch,
      "the same controller incarnation answered the wake",
    );
    const events = (snapshot.events ?? []).filter(
      (event) => event.session === binding.session && event.generation === binding.generation,
    );
    check(
      events.some((event) => event.kind === "invalidated"),
      `the controller recorded the pre-suspend generation as invalidated (events: ${events.map((event) => event.kind).join(", ") || "none"})`,
    );
    const retained = (snapshot.retainedSessions ?? []).find(
      (entry) => entry.id === binding.session && entry.generation === binding.generation,
    );
    check(
      retained?.reason === "discontinuity",
      `the retained consumer names a discontinuity instead of an expired lease (reason: ${retained?.reason ?? "absent"})`,
    );

    // Re-observation is the shipped client's path back to a usable session.
    const reobserved = cliJson(
      [
        "controller",
        "observe",
        checkpoint.controller.checkout,
        "--session",
        binding.session,
        "--profile",
        "full",
        "--require",
        "app:web",
      ],
      controllerEnv,
    ) as { result?: Binding };
    const replacement = reobserved.result;
    check(
      !!replacement &&
        typeof replacement.generation === "string" &&
        replacement.generation !== binding.generation,
      "re-observation hands the same consumer a fresh generation",
    );
    if (!replacement || typeof replacement.generation !== "string") {
      failures.push("the wake produced no usable replacement binding to read protection from");
    } else {
      check(
        replacement.store === binding.store && replacement.epoch === binding.epoch,
        "the replacement generation stays on the same controller incarnation",
      );
      const protection = cliJson(protectionArgs(replacement), controllerEnv) as {
        result?: Record<string, unknown>;
      };
      const protectionResult = protection.result ?? {};
      const continuity = String(protectionResult.continuity);
      const graceRemainingMs = Number(protectionResult.graceRemainingMs);
      const awakeMs = Date.now() - pair.wake.atMs;
      const beforeSleepMs = pair.sleep.atMs - checkpoint.protection.measuredAtMs;
      check(
        continuity === "continuity-unknown" || continuity === "revalidation-required",
        `the wake left protection at ${continuity} instead of continuing the session`,
      );
      check(
        Number.isFinite(graceRemainingMs) && graceRemainingMs >= 0 && graceRemainingMs <= 60_000,
        `protection reports a bounded grace window (${graceRemainingMs}ms remaining)`,
      );
      if (continuity === "continuity-unknown" && beforeSleepMs > 60_000)
        facts.push(
          `the grace window had already expired ${Math.round(beforeSleepMs / 1000)}s before the host slept, so continuity-unknown proves the wake re-armed it`,
        );
      else if (continuity === "continuity-unknown")
        facts.push(
          "the host slept inside the pre-suspend grace window, so this reading does not prove a re-arm on its own",
        );
      else
        check(
          awakeMs > 60_000,
          `continuity-unknown was superseded only after the reset window elapsed (${Math.round(awakeMs / 1000)}s awake)`,
        );
      check(
        protectionResult.consentSatisfied === false,
        "parking consent is not satisfied by a continuity break alone",
      );
      check(
        Number(protectionResult.liveConsumers) === 1,
        "only the re-observed consumer counts as live after the wake",
      );
      if (Number(protectionResult.unresolvedConsumers) > 0)
        facts.push(
          `the pre-suspend generation stays retained as unresolved evidence (${protectionResult.unresolvedConsumers}) until a client reconnects or releases it`,
        );
    }

    let answer = fetchRoute(checkpoint.live.url, ca);
    let recovered = false;
    if (!answer.ok) {
      cli(["app", "run", LIVE_APP, "--repo", checkpoint.live.repo], { allowFailure: true });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !answer.ok) {
        answer = fetchRoute(checkpoint.live.url, ca);
        if (!answer.ok) await delay(1_000);
      }
      recovered = answer.ok;
    }
    check(answer.ok, "the published route answers after the wake");
    check(
      answer.body === checkpoint.live.token,
      `the route still serves the recorded token (saw ${JSON.stringify(answer.body.slice(0, 24))})`,
    );
    if (recovered) facts.push("the ordinary app-run path recovered the fixture after the wake");
  } finally {
    releaseLiveFixture(checkpoint);
    await stopOwnedPid(path.join(WORK, "heartbeat.pid"), [
      "devrouter-host-suspend-heartbeat",
      DIST,
    ]);
    await stopOwnedPid(path.join(WORK, "controller.pid"), [DIST, "controller run"]);
  }

  const receipt = {
    schema: "devrouter.host-suspend.v1",
    outcome: failures.length ? "fail" : "pass",
    preparedAt: checkpoint.preparedAt,
    verifiedAt: new Date().toISOString(),
    revision: checkpoint.revision,
    distSha256: checkpoint.distSha256,
    suspend: { sleep: pair.sleep.line, wake: pair.wake.line, sleptSeconds },
    facts,
    failures,
    limitation:
      "capacity-window clearing on a clock discontinuity remains source-covered by capacity-accounting.test.ts; this cell drives no live admission across the suspend",
  };
  fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2));
  for (const fact of facts) process.stdout.write(`ok: ${fact}\n`);
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stdout.write(`receipt: ${RECEIPT}\n`);
  if (failures.length) process.exit(1);
  process.stdout.write("host-suspend qualification passed\n");
}

async function main() {
  const phase = process.argv[2] ?? "prepare";
  if (phase === "prepare") await prepare();
  else if (phase === "verify") await verify();
  else fail(`unknown phase ${JSON.stringify(phase)}; expected prepare or verify.`);
}

void main().catch((error) => {
  // The failing frame is the whole diagnostic for an unexpected fixture error.
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  fail(error instanceof Error ? error.message : String(error));
});
