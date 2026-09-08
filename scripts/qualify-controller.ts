import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createReliabilityState } from "../src/core/reliability-contract";

async function main() {
  // A short isolated HOME keeps the production Unix socket path valid on macOS.
  const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "dr-observe-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const control = path.join(root, "repo");
  const checkout = path.join(control, "trees", "fixture");
  for (const directory of [home, bin, control]) fs.mkdirSync(directory);
  const node = fs.realpathSync(process.execPath);
  function run(command: string, args: string[], cwd = process.cwd(), env = process.env) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, `Qualification command failed: ${command}`);
    return result.stdout.trim();
  }
  const sourceRevision = run("git", ["rev-parse", "HEAD"]);
  const dirty = run("git", ["status", "--porcelain"]) !== "";
  run("pnpm", ["build"], process.cwd(), {
    ...process.env,
    pnpm_config_verify_deps_before_run: "false",
  });
  run("pnpm", ["pack", "--pack-destination", root]);
  const packed = fs.readdirSync(root).filter((name) => name.endsWith(".tgz"));
  assert.equal(packed.length, 1);
  const tarball = path.join(root, packed[0]);
  const install = path.join(root, "install");
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--prefix",
    install,
    tarball,
  ]);
  const cli = path.join(install, "node_modules", "@devrouter", "cli", "dist", "devrouter.js");
  run("git", ["init", "--quiet", control]);
  run("git", [
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
  run("git", ["-C", control, "worktree", "add", "-b", "fixture", checkout]);
  const gitDir = run("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"]);
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
  const mutations = path.join(root, "unexpected-provider-call.jsonl");
  const calls = path.join(root, "observations.jsonl");
  const phase = path.join(root, "phase");
  const held = path.join(root, "held");
  const releaseProbe = path.join(root, "release-probe");
  fs.writeFileSync(phase, "ready");
  const routerHome = path.join(home, ".config", "devrouter");
  const composeDirectory = path.join(checkout, ".devcontainer");
  fs.mkdirSync(composeDirectory);
  const composeFile = path.join(composeDirectory, "compose.yml");
  fs.writeFileSync(
    composeFile,
    "services:\n  app:\n    image: fixture\n  db:\n    image: fixture\n",
  );
  const source = JSON.stringify({ service: "app", dockerComposeFile: "compose.yml" });
  fs.writeFileSync(path.join(composeDirectory, "devcontainer.json"), source);
  fs.writeFileSync(path.join(composeDirectory, "devcontainer.devrouter.json"), source);
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const stateFile = path.join(routerHome, "managed-runtime", `${sha(`${checkout}\0fixture`)}.json`);
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
      sourceConfigSha256: sha(source),
      effectiveConfigSha256: sha(source),
      status: "ready",
      updatedAt: new Date().toISOString(),
    }),
  );
  const journalFile = path.join(routerHome, "reliability", `${sha(checkout)}.json`);
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const state = createReliabilityState(sha(checkout), 0, "manual");
  state.desired = "running";
  state.phase = "stable";
  const journal = {
    version: 1,
    identity: { repoPath: checkout, workspace: "fixture", provider: "devsy" },
    revision: 1,
    state,
    worker: null,
    effectSequence: 0,
    outcome: null,
  };
  const writeJournal = () =>
    fs.writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 });
  writeJournal();
  const routeFile = path.join(routerHome, "host-routes-state.json");
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
      "com.docker.compose.project.working_dir": composeDirectory,
      "com.docker.compose.project.config_files": composeFile,
      "com.docker.compose.config-hash": "c".repeat(64),
    },
    mounts: [{ Type: "bind", Source: checkout, Destination: "/workspace" }],
    networks: {},
  }));
  for (const provider of ["devpod", "devsy", "docker", "curl"]) {
    const script = `#!${node}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const provider=${JSON.stringify(provider)};
const phase=fs.readFileSync(${JSON.stringify(phase)},'utf8');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({provider,operation:args[0]})+'\\n');
const snapshots=${JSON.stringify(snapshots)};
if(provider==='devpod' && JSON.stringify(args)===JSON.stringify(['list','--output','json','--skip-pro'])) process.stdout.write('[]');
else if(provider==='devsy' && JSON.stringify(args)===JSON.stringify(['workspace','list','--result-format','json','--skip-pro'])) process.stdout.write(${JSON.stringify(JSON.stringify([{ id: "fixture", source: { localFolder: checkout } }]))});
else if(provider==='docker' && JSON.stringify(args)===JSON.stringify(['ps','-a','--no-trunc','--filter','label=com.docker.compose.project=fixture','--format','{{.ID}}'])) {
  const reply=()=>process.stdout.write(snapshots.map(x=>x.id).join('\\n'));
  if(phase==='held' && !fs.existsSync(${JSON.stringify(releaseProbe)})) {
    fs.writeFileSync(${JSON.stringify(held)},'held');
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseProbe)})){clearInterval(timer);reply();}},20);
  } else reply();
}
else if(provider==='docker' && args[0]==='inspect' && args[1]==='--format' && JSON.stringify(args.slice(3))===JSON.stringify(snapshots.map(x=>x.id))) process.stdout.write(snapshots.map(x=>JSON.stringify(phase==='stopped'?{...x,state:{...x.state,Running:false,Status:'exited'}}:x)).join('\\n'));
else if(provider==='docker' && args[0]==='compose' && args[1]==='--project-name' && args[2]==='fixture' && args[3]==='--project-directory' && args[4]===${JSON.stringify(composeDirectory)} && JSON.stringify(args.slice(5))===JSON.stringify(['-f',${JSON.stringify(composeFile)},'config','--format','json'])) process.stdout.write('{}');
else if(provider==='docker' && args[0]==='compose' && args[1]==='--project-name' && args[2]==='fixture' && args[3]==='--project-directory' && args[4]===${JSON.stringify(composeDirectory)} && JSON.stringify(args.slice(5,-1))===JSON.stringify(['-f','-','config','--no-interpolate','--hash']) && ['app','db'].includes(args.at(-1))) { process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(args.at(-1)+' '+'c'.repeat(64))); }
else if(provider==='docker' && args[0]==='exec' && args[1]===snapshots[0].id && JSON.stringify(args.slice(2,7))===JSON.stringify(['timeout','--signal=KILL','2s','bash','-c']) && args[8]==='observer' && args[9]==='web' && args.length===10) process.stdout.write('123 456 fixture');
else if(provider==='curl' && JSON.stringify(args)===JSON.stringify(['--disable','--globoff','--silent','--show-error','--no-location','--noproxy','*','--output','/dev/null','--write-out','%{http_code}\\t%{content_type}','--max-time','2','http://web.fixture.localhost/health'])) process.stdout.write((phase==='error'?'500':'200')+'\\tapplication/json');
else { fs.appendFileSync(${JSON.stringify(mutations)},JSON.stringify({provider,args})+'\\n'); process.exit(1); }\n`;
    fs.writeFileSync(path.join(bin, provider), script, { mode: 0o700 });
  }
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    LC_ALL: "C",
    NODE_OPTIONS: "",
    DOCKER_HOST: `unix://${root}/absent.sock`,
  };
  const socketPath = path.join(home, ".config", "devrouter", "controller", "control.sock");
  let controller: ChildProcess | undefined;
  async function start() {
    controller = spawn(node, [cli, "controller", "run"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (controller.exitCode !== null)
        throw new Error("Fixture controller exited during startup.");
      if (fs.existsSync(socketPath)) {
        const connected = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection(socketPath);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (connected) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Fixture controller startup timed out.");
  }
  async function stop(signal: NodeJS.Signals = "SIGTERM") {
    const child = controller;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Fixture controller did not stop."));
      }, 5000);
      child.once("exit", () => {
        clearTimeout(deadline);
        resolve();
      });
      child.kill(signal);
    });
    controller = undefined;
  }
  function command(...args: string[]) {
    return JSON.parse(run(node, [cli, "controller", ...args, "--json"], root, env));
  }
  const evidence: string[] = [];
  const qualificationStartedAt = performance.now();
  let maximumObservedRssKiB = 0;
  let maximumObservedCpuPercent = 0;
  let rssSamples = 0;
  const statusWaits: Array<{ session: string; expected: string; elapsedMs: number }> = [];
  async function untilStatus(session: string, expected: string) {
    const started = performance.now();
    const deadline = Date.now() + 14_000;
    while (Date.now() < deadline) {
      const actual = command("status", "--session", session).result.sessions[0];
      assert.ok(controller?.pid, "fixture observer PID unavailable");
      const [rss, cpu] = run("ps", ["-o", "rss=", "-o", "%cpu=", "-p", String(controller.pid)])
        .split(/\s+/)
        .map(Number);
      assert.ok(Number.isFinite(rss) && rss > 0, "fixture observer memory sample unavailable");
      assert.ok(Number.isFinite(cpu) && cpu >= 0, "fixture observer CPU sample unavailable");
      maximumObservedRssKiB = Math.max(maximumObservedRssKiB, rss);
      maximumObservedCpuPercent = Math.max(maximumObservedCpuPercent, cpu);
      rssSamples++;
      if (actual?.status === expected) {
        statusWaits.push({ session, expected, elapsedMs: Math.round(performance.now() - started) });
        return actual;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Expected ${expected} for synthetic ${session}`);
  }
  try {
    await start();
    const first = command(
      "observe",
      checkout,
      "--session",
      "one",
      "--profile",
      "full",
      "--require",
      "runtime",
    ).result;
    const second = command(
      "observe",
      checkout,
      "--session",
      "two",
      "--profile",
      "full",
      "--require",
      "app:web",
    ).result;
    assert.equal(command("status").result.sessions.length, 2);
    evidence.push("packed CLI acquires two independent consumer sessions");
    await untilStatus("one", "READY");
    await untilStatus("two", "READY");
    const journalBefore = fs.readFileSync(journalFile, "utf8");
    fs.writeFileSync(phase, "error");
    await untilStatus("two", "APP_ERROR");
    await untilStatus("one", "READY");
    assert.equal(fs.readFileSync(journalFile, "utf8"), journalBefore);
    evidence.push(
      "production collector continuously observes APP_ERROR while runtime remains READY without journal writes",
    );
    command(
      "release",
      "--session",
      first.session,
      "--store",
      first.store,
      "--epoch",
      String(first.epoch),
      "--generation",
      first.generation,
    );
    assert.equal(command("status").result.sessions.length, 1);
    evidence.push("release retains the other consumer");
    fs.writeFileSync(phase, "held");
    const holdDeadline = Date.now() + 8_000;
    while (!fs.existsSync(held) && Date.now() < holdDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(held), true, "collector did not reach the held probe");
    journal.revision++;
    state.desired = "stopped-by-user";
    state.stopProof = { workloadsStopped: false, routesRemoved: false };
    writeJournal();
    fs.writeFileSync(releaseProbe, "release");
    await untilStatus("two", "UNKNOWN");
    evidence.push("manual stop revision rejects an in-flight pre-stop production sample");
    journal.revision++;
    state.desired = "stopped-by-user";
    state.phase = "idle";
    state.stopProof = { workloadsStopped: true, routesRemoved: true };
    fs.writeFileSync(phase, "stopped");
    fs.writeFileSync(routeFile, "[]");
    writeJournal();
    await untilStatus("two", "STOPPED");
    evidence.push("manual stopped journal and exact stopped resources supersede prior readiness");
    const eventsBeforeRestart =
      JSON.parse(fs.readFileSync(path.join(routerHome, "controller", "snapshot.json"), "utf8"))
        .nextSequence - 1;
    await stop("SIGKILL");
    await start();
    const replacement = command(
      "observe",
      checkout,
      "--session",
      "two",
      "--profile",
      "full",
      "--require",
      "runtime",
    ).result;
    assert.equal(replacement.store, second.store);
    assert.equal(replacement.epoch, second.epoch + 1);
    assert.notEqual(replacement.generation, second.generation);
    const stale = spawnSync(
      node,
      [
        cli,
        "controller",
        "renew",
        "--session",
        second.session,
        "--store",
        second.store,
        "--epoch",
        String(second.epoch),
        "--generation",
        second.generation,
        "--json",
      ],
      { cwd: root, env, encoding: "utf8", timeout: 5000 },
    );
    assert.notEqual(stale.status, 0);
    evidence.push("observer restart invalidates prior session epoch and generation");
    await stop();
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(mutations), false);
    const sha256 = (file: string) =>
      createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const receipt = {
      schemaVersion: 1,
      scope: "continuous-observation",
      sourceRevision,
      dirty,
      tarballSha256: sha256(tarball),
      cliSha256: sha256(cli),
      evidence,
      controllerStopped: true,
      unexpectedProviderCalls: 0,
      continuousObservationQualified: true,
      providerReadCalls: fs.readFileSync(calls, "utf8").trim().split("\n").length,
      elapsedMs: Math.round(performance.now() - qualificationStartedAt),
      maximumObservedRssKiB,
      maximumObservedCpuPercent,
      rssSamples,
      statusWaits,
      eventsBeforeRestart,
    };
    fs.writeFileSync(path.join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ root, ...receipt }));
  } finally {
    await stop();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Controller qualification failed.");
  process.exitCode = 1;
});
