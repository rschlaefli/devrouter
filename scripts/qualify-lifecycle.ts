import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ownedInvocations = new Set<ChildProcess>();

// All provider invocations resolve to these closed synthetic fixtures. The installed
// package receives a fresh home and no host environment or provider socket.
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qualify-lifecycle-")));
  console.error(`Synthetic qualification artifacts: ${root}`);
  const source = process.cwd();
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(root, "checkout");
  const fixture = path.join(root, "fixture.json");
  for (const directory of [bin, home, repo]) fs.mkdirSync(directory);
  const node = fs.realpathSync(process.execPath);
  function run(command: string, args: string[], cwd = source, env = process.env) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, `${command} failed: ${result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
  }
  function digest(file: string) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  const sourceRevision = run("git", ["rev-parse", "HEAD"]);
  const dirty = run("git", ["status", "--porcelain"]) !== "";
  run("pnpm", ["build"]);
  run("pnpm", ["pack", "--pack-destination", root]);
  const tarballs = fs.readdirSync(root).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = path.join(root, tarballs[0]);
  const prefix = path.join(root, "install");
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    prefix,
    "--no-save",
    tarball,
  ]);
  const installed = path.join(prefix, "node_modules/@devrouter/cli/dist");
  const cli = path.join(installed, "devrouter.js");
  const worker = path.join(installed, "devrouter-lifecycle-worker.js");
  assert.ok(fs.existsSync(worker));
  run("git", ["init", "--quiet", repo]);
  fs.writeFileSync(path.join(repo, ".devrouter.yml"), "version: 1\napps: []\n");
  const closedEnv = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    LC_ALL: "C",
    DOCKER_HOST: `unix://${root}/nonexistent.sock`,
    DEVROUTER_WORKSPACE_RUNTIME: "devpod",
    LIFECYCLE_FIXTURE: fixture,
    NODE_PATH: path.join(prefix, "node_modules"),
    NODE_OPTIONS: "",
    LIFECYCLE_FAULT: "",
  };
  const faultPreload = path.join(root, "fault-preload.cjs");
  fs.writeFileSync(
    faultPreload,
    `
const fs = require('node:fs');
const rename = fs.renameSync;
const sync = fs.fsyncSync;
if (process.env.LIFECYCLE_FAULT === 'duplicate-identity') {
  require('node:crypto').randomUUID = () => '00000000-0000-4000-8000-000000000001';
}
const cp = require('node:child_process');
const fork = cp.fork;
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (process.env.LIFECYCLE_FAULT === 'spawn-failure' && command === 'devpod' && args.includes('ssh')) {
    fs.chmodSync(require('node:path').join(process.env.PATH.split(':')[0], 'devpod'), 0o600);
    fs.writeFileSync(process.env.LIFECYCLE_FIXTURE+'.spawn-failure', 'EACCES');
  }
  return spawn.call(cp, command, args, options);
};
cp.fork = function(...args) {
  const child = fork.apply(cp, args);
  if (process.env.LIFECYCLE_FAULT === 'duplicate-request') {
    const send = child.send.bind(child);
    child.send = function(message, callback) {
      fs.writeFileSync(process.env.LIFECYCLE_FIXTURE+'.duplicate', 'two requests');
      send(message, callback);
      return send(message, () => {});
    };
  }
  if (process.env.LIFECYCLE_FAULT === 'before-dispatch') {
    const on = child.on.bind(child);
    child.on = function(event, listener) {
      if (event !== 'message') return on(event, listener);
      return on(event, message => {
        if (!message?.ready) return listener(message);
        const barrier = process.env.LIFECYCLE_FIXTURE+'.ready';
        const release = barrier+'.release';
        const watcher = fs.watch(require('node:path').dirname(barrier), () => {
          if (fs.existsSync(release)) { watcher.close(); listener(message); }
        });
        fs.writeFileSync(barrier, String(child.pid));
      });
    };
  }
  return child;
};
let uncertain = false;
fs.renameSync = function(from, to) {
  if (String(to).includes('/reliability/') && String(to).endsWith('.json')) {
    const record = JSON.parse(fs.readFileSync(from, 'utf8'));
    const mode = process.env.LIFECYCLE_FAULT;
    if (record.state.operation?.status === 'DISPATCH_PENDING' && !fs.existsSync(process.env.LIFECYCLE_FIXTURE+'.fault')) {
      fs.writeFileSync(process.env.LIFECYCLE_FIXTURE+'.fault', mode);
      if (mode === 'before-persist') throw new Error('synthetic pre-rename failure');
      if (mode === 'after-persist') {
        rename.call(fs, from, to);
        uncertain = true;
        return;
      }
    }
  }
  return rename.call(fs, from, to);
};
fs.fsyncSync = function(fd) {
  if (uncertain) throw new Error('synthetic durability acknowledgement failure');
  return sync.call(fs, fd);
};
`,
  );
  const fixtureSource = `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.LIFECYCLE_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const command = path.basename(process.argv[1]);
const workspaceId = state.workspaceId ?? 'fixture';
const containerId = state.containerId ?? 'a'.repeat(64);
const args = process.argv.slice(2);
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
const fail = () => { fs.appendFileSync(file + '.unexpected', JSON.stringify({command,args})+'\\n'); process.exit(90); };
const write = () => fs.writeFileSync(file, JSON.stringify(state));
if (command === 'devpod' && args[0] === 'version') { console.log('fixture'); }
else if (command === 'devsy' && args[0] === '--version') { console.log('fixture'); }
else if (command === 'devpod' && args.join(' ') === 'list --output json --skip-pro') { output(state.provider === 'devpod' ? [{id:workspaceId,source:{localFolder:state.repo}}] : []); }
else if (command === 'devsy' && args.join(' ') === 'workspace list --result-format json --skip-pro') { output(state.provider === 'devsy' ? [{id:workspaceId,source:{localFolder:state.repo}}] : []); }
else if (command === 'devpod' && [ 'up '+state.repo+' --id fixture --open-ide=false', 'up '+state.repo+' --id fixture --devcontainer-path .devcontainer/devcontainer.devrouter.json --open-ide=false' ].includes(args.join(' '))) { state.running=true; state.starts=(state.starts??0)+1; write(); if(state.mode === 'start-failure') process.exit(1); }
else if (command === 'devpod' && args[0] === 'status' && args[1] === workspaceId) { output({id:workspaceId,state:state.running?'Running':'Stopped'}); }
else if (command === 'devsy' && args[0] === 'workspace' && args[1] === 'status' && args[2] === workspaceId) { output({id:workspaceId,state:state.running?'Running':'Stopped'}); }
else if (command === 'curl') {
 const yaml = require('yaml');
 const routesFile = path.join(process.env.HOME,'.config/devrouter/traefik/dynamic/host-routes.yml');
 const document = fs.existsSync(routesFile) ? yaml.parse(fs.readFileSync(routesFile,'utf8')) : {};
 const url = args.at(-1);
 const parsedUrl = new URL(url);
 const parts = parsedUrl.pathname.split('/');
 const api = parsedUrl.origin === 'http://127.0.0.1:8080' && parts[1] === 'api' && ['http','tcp'].includes(parts[2]) && ['routers','services'].includes(parts[3]) ? [null,parts[2],parts[3],parts[4] ? '/'+parts[4] : parsedUrl.search] : null;
 if (api) {
  const entries = document[api[1]]?.[api[2]] ?? {};
  if(api[3].startsWith('?per_page=')) output(Object.keys(entries).map(name=>({name:name+'@file'})));
  else {
   const name=decodeURIComponent(api[3].slice(1)); const key=name.replace(/@file$/,'');
   if(!entries[key]) fail();
   output({...entries[key],name,status:'enabled'});
  }
 } else if (args.includes('%{http_code}') && url === 'http://fixture.localhost') {
  if(state.mode === 'readiness-hold') { fs.writeFileSync(file+'.readiness', String(process.pid)); setInterval(()=>{},1000); } else if(Object.values(document.http?.routers??{}).some(router=>router.rule==='Host('+String.fromCharCode(96)+'fixture.localhost'+String.fromCharCode(96)+')')) console.log('200'); else fail();
 } else fail();
}
else if (command === 'docker' && args.join(' ') === 'context show') console.log('fixture');
else if (command === 'docker' && args[0] === 'context' && args[1] === 'inspect' && args[2] === 'fixture') console.log('unix://'+file+'.sock');
else if (command === 'docker' && args.join(' ') === 'exec '+containerId+' git -C /workspace rev-parse --show-toplevel') console.log('/workspace');
else if (command === 'docker' && args.join(' ') === 'compose -f '+process.env.HOME+'/.config/devrouter/compose.yml up -d') { }
else if (command === 'docker' && args[0] === 'compose' && args.includes('--services') && args.includes('--no-env-resolution')) console.log('app');
else if (command === 'docker' && args[0] === 'compose' && args.includes('--hash') && args.at(-1) === 'app') { fs.readFileSync(0); console.log('app '+'0'.repeat(64)); }
else if (command === 'docker' && args[0] === 'compose' && args.includes('config') && args.includes('--format') && args.at(-1) === 'json') output({services:{app:{image:'synthetic'}}});
else if (command === 'docker' && args[0] === 'exec' && args[1] === '-i' && args[2] === containerId && args[3] === 'sh') { fs.readFileSync(0); state.deliveries=(state.deliveries??0)+1; write(); }
else if (command === 'docker' && args[0] === 'exec' && args.includes(containerId) && args.includes('DEVROUTER_PROCESS_SET=') && args.includes('.devcontainer/post-start.sh')) { state.adapters=(state.adapters??0)+1; write(); }
else if (command === 'docker' && args[0] === 'ps' && args.includes('{{.ID}}')) { console.log(containerId); }
else if (command === 'docker' && args[0] === 'inspect' && args.at(-1) === containerId && args[1] === '--format') {
 output({id:containerId,state:{Running:state.running,Status:state.running?'running':'exited',Paused:false,Restarting:false,Dead:false},labels:{'com.docker.compose.project':'fixture','com.docker.compose.service':'app','com.docker.compose.project.working_dir':state.repo+'/.devcontainer','com.docker.compose.project.config_files':state.repo+'/.devcontainer/compose.yml','com.docker.compose.config-hash':'0'.repeat(64)},mounts:[{Type:'bind',Source:state.repo,Destination:'/workspace'}],networks:{devnet:{Aliases:["fixture-app"]}}});
}
else if ((command === 'devpod' && args[2] === 'ssh' && args[3] === workspaceId) || (command === 'devsy' && args[0] === 'workspace' && args[1] === 'exec' && args[4] === workspaceId)) {
 state.launches++; write();
 if (state.mode === 'hold') { fs.writeFileSync(file+'.barrier', String(process.pid)); setInterval(()=>{}, 1000); }
 else if (state.mode === 'unknown') process.kill(process.pid, 'SIGKILL');
 else if (command === 'devpod') {
  const wrapped = args[args.indexOf('--command')+1];
  const marker = wrapped.match(/(__DEVROUTER_EXIT_[A-Za-z0-9-]+__:)/)?.[1];
  if (!marker) fail();
  process.stderr.write(marker+String(state.exitCode)+'\\n', () => { if(state.mode==='marker-signal') process.kill(process.pid,'SIGKILL'); });
 } else process.exit(state.exitCode);
}
else if ((command==='devpod' && args[0]==='stop' && args[1]===workspaceId) || (command==='devsy' && args[0]==='workspace' && args[1]==='stop' && args[2]===workspaceId)) { state.running=false; write(); }
else fail();
`;
  for (const command of ["docker", "devpod", "devsy", "mkcert", "curl"])
    fs.writeFileSync(path.join(bin, command), fixtureSource, { mode: 0o700 });
  let journal = path.join(
    home,
    ".config/devrouter/reliability",
    `${createHash("sha256").update(repo).digest("hex")}.json`,
  );
  const read = () => JSON.parse(fs.readFileSync(journal, "utf8"));
  function configure(mode: string, exitCode = 0, provider = "devpod") {
    fs.writeFileSync(
      fixture,
      JSON.stringify({ mode, exitCode, provider, repo, running: true, launches: 0 }),
    );
  }
  function invoke(args: string[]) {
    return spawnSync(node, [cli, ...args], {
      cwd: repo,
      env: closedEnv,
      encoding: "utf8",
      timeout: 20_000,
    });
  }
  function expectExit(args: string[], code: number) {
    const result = invoke(args);
    assert.equal(
      result.status,
      code,
      `${args[0]}: ${result.error ?? ""} ${result.stderr} ${result.stdout}`,
    );
  }
  const evidence: string[] = [];
  configure("complete", 7);
  expectExit(["exec", repo, "--", "synthetic"], 7);
  assert.equal(read().state.operation.exitCode, 7);
  assert.equal(read().state.operation.drained, true);
  evidence.push("proven failure persisted and CLI exit preserved");
  configure("marker-signal", 0);
  expectExit(["exec", repo, "--", "synthetic"], 0);
  assert.equal(read().state.operation.exitCode, 0);
  assert.equal(read().outcome.transport.signal, "SIGKILL");
  evidence.push("operation marker remains authoritative after provider signal");
  configure("unknown");
  expectExit(["exec", repo, "--", "synthetic"], 1);
  assert.notEqual(read().state.operation.status, "COMPLETED");
  expectExit(["exec", repo, "--", "synthetic"], 1);
  assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
  evidence.push("unknown completion blocks replay");
  expectExit(["stop", repo, "--json"], 0);
  assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
  evidence.push("stop requires worker drainage and synthetic workload cessation");
  function freshHome(label: string) {
    closedEnv.HOME = path.join(root, label);
    fs.mkdirSync(closedEnv.HOME);
    journal = path.join(
      closedEnv.HOME,
      ".config/devrouter/reliability",
      `${createHash("sha256").update(repo).digest("hex")}.json`,
    );
  }
  function watchUntil(file: string, predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const watcher = fs.watch(path.dirname(file), check);
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error(`Fixture barrier timed out: ${file}`));
      }, 10_000);
      function check() {
        try {
          if (predicate()) {
            clearTimeout(timer);
            watcher.close();
            resolve();
          }
        } catch {
          /* An atomic rename can briefly hide the watched record. */
        }
      }
      check();
    });
  }
  function launch(args: string[]) {
    const child = spawn(node, [cli, ...args], {
      cwd: repo,
      env: closedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ownedInvocations.add(child);
    child.once("close", () => ownedInvocations.delete(child));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    return { child, done, output: () => output };
  }
  async function qualifyEnsure() {
    freshHome("ensure-home");
    configure("complete");
    fs.writeFileSync(
      path.join(repo, ".devrouter.yml"),
      "version: 1\nproject:\n  name: fixture\napps:\n  - name: web\n    runtime: proxy\n    protocol: http\n    host: fixture.localhost\n    upstream: fixture-app:3000\n",
    );
    const apiRequests: string[] = [];
    let releaseNetwork: (() => void) | undefined;
    const server = http.createServer((request, response) => {
      apiRequests.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/networks/devnet") {
        response.setHeader("content-type", "application/json");
        if (JSON.parse(fs.readFileSync(fixture, "utf8")).mode === "network-hold") {
          releaseNetwork = () => response.end(JSON.stringify({ Name: "devnet" }));
          fs.writeFileSync(`${fixture}.network-barrier`, "entered");
        } else response.end(JSON.stringify({ Name: "devnet" }));
      } else {
        fs.appendFileSync(`${fixture}.unexpected`, `${request.method} ${request.url}\n`);
        response.writeHead(500);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(`${fixture}.sock`, resolve);
    });
    try {
      const first = launch(["ensure", repo, "--json"]);
      assert.equal(await first.done, 0, first.output());
      const generation = read().state.runtimeGeneration;
      const next = launch(["ensure", repo, "--json"]);
      assert.equal(await next.done, 0, next.output());
      assert.equal(read().state.runtimeGeneration, generation);
      assert.equal(read().state.operationHistory.length, 2);
      assert.equal(apiRequests.length, 2);
      configure("network-hold");
      const interrupted = launch(["ensure", repo, "--json"]);
      await watchUntil(`${fixture}.network-barrier`, () =>
        fs.existsSync(`${fixture}.network-barrier`),
      );
      interrupted.child.kill("SIGTERM");
      assert.equal(await interrupted.done, 1, interrupted.output());
      assert.equal(read().state.operation.status, "INTERRUPTED");
      configure("complete");
      releaseNetwork?.();
      fs.unlinkSync(`${fixture}.network-barrier`);
      const recovered = launch(["ensure", repo, "--json"]);
      assert.equal(await recovered.done, 0, recovered.output());
      assert.ok(
        read().state.operationHistory.some(
          (entry: { status: string }) => entry.status === "INTERRUPTED",
        ),
      );
      evidence.push(
        "installed ensure reconciles drained interrupted startup without explicit stop or result erasure",
      );
      expectExit(["stop", repo, "--json"], 0);
      assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
      configure("network-hold");
      const delayed = launch(["ensure", repo, "--json"]);
      await watchUntil(`${fixture}.network-barrier`, () =>
        fs.existsSync(`${fixture}.network-barrier`),
      );
      const stopped = launch(["stop", repo, "--json"]);
      await watchUntil(journal, () => read().state.desired === "stopped-by-user");
      assert.ok(releaseNetwork);
      releaseNetwork();
      assert.equal(await delayed.done, 1, delayed.output());
      assert.equal(await stopped.done, 0, stopped.output());
      assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
      evidence.push(
        "stop during delayed infrastructure return prevents stale route publication and rollback",
      );
      configure("readiness-hold");
      const published = launch(["ensure", repo, "--json"]);
      await watchUntil(`${fixture}.readiness`, () => fs.existsSync(`${fixture}.readiness`));
      const stopPublished = launch(["stop", repo, "--json"]);
      await watchUntil(journal, () => read().state.desired === "stopped-by-user");
      assert.equal(await published.done, 1, published.output());
      assert.equal(await stopPublished.done, 0, stopPublished.output());
      assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
      evidence.push(
        "stop after route publication drains readiness work and prevents stale rollback restoration",
      );
      freshHome("managed-home");
      configure("complete");
      const managedConfig =
        fs.readFileSync(path.join(repo, ".devrouter.yml"), "utf8") +
        "managedRuntime:\n  devcontainer:\n    baseServices: []\n    profileServices: []\n  processes: []\n";
      fs.writeFileSync(path.join(repo, ".devrouter.yml"), managedConfig);
      fs.mkdirSync(path.join(repo, ".devcontainer"));
      fs.writeFileSync(
        path.join(repo, ".gitignore"),
        ".devcontainer/devcontainer.devrouter.json\n",
      );
      fs.writeFileSync(
        path.join(repo, ".devcontainer/compose.yml"),
        "services:\n  app:\n    image: synthetic\n",
      );
      fs.writeFileSync(
        path.join(repo, ".devcontainer/devcontainer.json"),
        JSON.stringify({
          dockerComposeFile: "compose.yml",
          service: "app",
          runServices: ["app"],
          workspaceFolder: "/workspace",
        }),
      );
      fs.writeFileSync(
        path.join(repo, ".devcontainer/post-start.sh"),
        '# devrouter:managed devcontainer\n: "$DEVROUTER_PROCESS_HELPER"\n',
      );
      const managed = launch(["ensure", repo, "--json"]);
      assert.equal(await managed.done, 0, managed.output());
      const stateDirectory = path.join(closedEnv.HOME, ".config/devrouter/managed-runtime");
      const stateName = fs.readdirSync(stateDirectory).find((name) => name.endsWith(".json"));
      assert.ok(stateName);
      const stateFile = path.join(stateDirectory, stateName);
      const managedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(managedState.status, "ready");
      managedState.status = "degraded";
      fs.writeFileSync(stateFile, JSON.stringify(managedState));
      const beforeRepair = JSON.parse(fs.readFileSync(fixture, "utf8"));
      const generated = path.join(repo, ".devcontainer/devcontainer.devrouter.json");
      const generatedBefore = fs.readFileSync(generated, "utf8");
      const repaired = launch(["ensure", repo, "--json"]);
      assert.equal(await repaired.done, 0, repaired.output());
      const afterRepair = JSON.parse(fs.readFileSync(fixture, "utf8"));
      assert.equal(afterRepair.adapters, beforeRepair.adapters + 1);
      assert.equal(afterRepair.starts, beforeRepair.starts);
      assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).status, "ready");
      assert.equal(fs.readFileSync(generated, "utf8"), generatedBefore);
      evidence.push(
        "installed ordinary ensure repairs retained degraded state with one adapter run and no provider bootstrap",
      );
      const neighbour = path.join(root, "neighbour");
      run("git", ["init", "--quiet", neighbour]);
      fs.writeFileSync(path.join(neighbour, ".devrouter.yml"), "version: 1\napps: []\n");
      const neighbourFixture = path.join(root, "neighbour-fixture.json");
      fs.writeFileSync(
        neighbourFixture,
        JSON.stringify({
          mode: "complete",
          exitCode: 0,
          provider: "devpod",
          repo: neighbour,
          workspaceId: "neighbour",
          containerId: "b".repeat(64),
          running: true,
          launches: 0,
        }),
      );
      const neighbourExec = () => {
        const result = spawnSync(node, [cli, "exec", neighbour, "--", "synthetic"], {
          cwd: neighbour,
          env: { ...closedEnv, LIFECYCLE_FIXTURE: neighbourFixture },
          encoding: "utf8",
          timeout: 20_000,
        });
        assert.equal(result.status, 0, result.stderr);
      };
      neighbourExec();
      const neighbourJournal = path.join(
        closedEnv.HOME,
        ".config/devrouter/reliability",
        `${createHash("sha256").update(neighbour).digest("hex")}.json`,
      );
      const neighbourBefore = fs.readFileSync(neighbourJournal, "utf8");
      expectExit(["stop", repo, "--json"], 0);
      assert.equal(fs.readFileSync(neighbourJournal, "utf8"), neighbourBefore);
      assert.equal(JSON.parse(fs.readFileSync(neighbourFixture, "utf8")).running, true);
      neighbourExec();
      assert.equal(JSON.parse(fs.readFileSync(neighbourFixture, "utf8")).launches, 2);
      assert.ok(!fs.existsSync(`${neighbourFixture}.unexpected`));
      evidence.push(
        "exact workspace stop preserves a neighbouring runtime and its independent operation journal",
      );
      freshHome("partial-start-home");
      configure("start-failure");
      const partialStart = launch(["ensure", repo, "--json"]);
      assert.equal(await partialStart.done, 1, partialStart.output());
      assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).running, true);
      assert.ok(
        fs.existsSync(generated),
        "partial provider start must retain generated configuration",
      );
      evidence.push(
        "failed provider startup retains managed configuration while its runtime may exist",
      );
      configure("complete");
      expectExit(["stop", repo, "--json"], 0);
      fs.unlinkSync(path.join(repo, ".devcontainer/post-start.sh"));
      fs.writeFileSync(path.join(repo, ".devrouter.yml"), "version: 1\napps: []\n");
      evidence.push(
        "installed route publication and exact route removal use synthetic Traefik proof",
      );
      evidence.push(
        "successive installed ensure calls preserve generation and reconcile independently",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  await qualifyEnsure();
  freshHome("spawn-failure-home");
  configure("complete");
  closedEnv.NODE_OPTIONS = `--require=${faultPreload}`;
  closedEnv.LIFECYCLE_FAULT = "spawn-failure";
  try {
    expectExit(["exec", repo, "--", "synthetic"], 1);
    assert.ok(fs.existsSync(`${fixture}.spawn-failure`));
    assert.equal(read().outcome.status, "not-started");
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 0);
  } finally {
    fs.chmodSync(path.join(bin, "devpod"), 0o700);
    closedEnv.NODE_OPTIONS = "";
    closedEnv.LIFECYCLE_FAULT = "";
  }
  evidence.push("installed provider spawn failure remains distinct from unknown completion");
  freshHome("duplicate-request-home");
  configure("complete");
  closedEnv.NODE_OPTIONS = `--require=${faultPreload}`;
  closedEnv.LIFECYCLE_FAULT = "duplicate-request";
  expectExit(["exec", repo, "--", "synthetic"], 0);
  assert.ok(fs.existsSync(`${fixture}.duplicate`));
  assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
  assert.equal(read().state.operationHistory.length, 1);
  evidence.push("duplicate installed IPC request identity executes at most once");
  freshHome("duplicate-identity-home");
  configure("hold");
  closedEnv.LIFECYCLE_FAULT = "duplicate-identity";
  const identityOwner = launch(["exec", repo, "--", "synthetic"]);
  await watchUntil(`${fixture}.barrier`, () => fs.existsSync(`${fixture}.barrier`));
  expectExit(["exec", repo, "--", "synthetic"], 1);
  assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
  closedEnv.NODE_OPTIONS = "";
  closedEnv.LIFECYCLE_FAULT = "";
  const identityStop = launch(["stop", repo, "--json"]);
  assert.equal(await identityOwner.done, 1, identityOwner.output());
  assert.equal(await identityStop.done, 0, identityStop.output());
  assert.equal(read().state.operationHistory.length, 1);
  fs.unlinkSync(`${fixture}.barrier`);
  evidence.push(
    "concurrent installed callers sharing request identity launch only one provider command",
  );
  freshHome("before-dispatch-home");
  configure("complete");
  closedEnv.NODE_OPTIONS = `--require=${faultPreload}`;
  closedEnv.LIFECYCLE_FAULT = "before-dispatch";
  const undispatched = launch(["exec", repo, "--", "synthetic"]);
  await watchUntil(`${fixture}.ready`, () => fs.existsSync(`${fixture}.ready`));
  closedEnv.NODE_OPTIONS = "";
  closedEnv.LIFECYCLE_FAULT = "";
  const stopBeforeDispatch = launch(["stop", repo, "--json"]);
  await watchUntil(journal, () => read().state.desired === "stopped-by-user");
  fs.writeFileSync(`${fixture}.ready.release`, "release");
  assert.equal(await undispatched.done, 1, undispatched.output());
  assert.equal(await stopBeforeDispatch.done, 0, stopBeforeDispatch.output());
  assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 0);
  evidence.push("stop before installed worker dispatch prevents provider launch");
  for (const fault of ["before-persist", "after-persist"]) {
    freshHome(fault);
    configure("complete");
    if (fs.existsSync(`${fixture}.fault`)) fs.unlinkSync(`${fixture}.fault`);
    closedEnv.NODE_OPTIONS = `--require=${faultPreload}`;
    closedEnv.LIFECYCLE_FAULT = fault;
    expectExit(["exec", repo, "--", "synthetic"], 1);
    assert.equal(fs.readFileSync(`${fixture}.fault`, "utf8"), fault);
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 0);
    closedEnv.NODE_OPTIONS = "";
    closedEnv.LIFECYCLE_FAULT = "";
    expectExit(["exec", repo, "--", "synthetic"], 1);
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 0);
    expectExit(["stop", repo, "--json"], 0);
    evidence.push(`${fault}: installed dispatch never launches without durable acknowledgement`);
  }
  async function races() {
    freshHome("race-home");
    configure("hold");
    const blocked = launch(["exec", repo, "--", "synthetic"]);
    try {
      await watchUntil(`${fixture}.barrier`, () => fs.existsSync(`${fixture}.barrier`));
      assert.equal(read().state.operation.status, "RUNNING");
      const stopped = launch(["stop", repo, "--json"]);
      try {
        await watchUntil(journal, () => read().state.desired === "stopped-by-user");
        assert.equal(await blocked.done, 1, blocked.output());
        assert.equal(await stopped.done, 0, stopped.output());
        assert.equal(read().worker, null);
        assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
        assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
        evidence.push("concurrent stop fences and drains an already-claimed execution");
      } finally {
        if (stopped.child.exitCode === null && stopped.child.signalCode === null)
          stopped.child.kill("SIGTERM");
      }
    } finally {
      if (blocked.child.exitCode === null && blocked.child.signalCode === null)
        blocked.child.kill("SIGTERM");
    }
    freshHome("supervisor-loss-home");
    fs.unlinkSync(`${fixture}.barrier`);
    configure("hold");
    const lost = launch(["exec", repo, "--", "synthetic"]);
    await watchUntil(`${fixture}.barrier`, () => fs.existsSync(`${fixture}.barrier`));
    const owned = read().worker;
    const providerPid = Number(fs.readFileSync(`${fixture}.barrier`, "utf8"));
    assert.ok(owned && owned.pid > 0);
    assert.equal(Number(run("ps", ["-o", "pgid=", "-p", String(providerPid)])), owned.pid);
    // The fixture provider identifies itself at a barrier while its owned worker
    // is still alive; verify that ancestry before the deliberate supervisor loss.
    const supervisorExited = new Promise<void>((resolve) =>
      lost.child.once("exit", () => resolve()),
    );
    lost.child.kill("SIGKILL");
    await supervisorExited;
    expectExit(["exec", repo, "--", "synthetic"], 1);
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
    // Release only this verified synthetic provider. Real providers are never signaled.
    process.kill(providerPid, "SIGTERM");
    await lost.done;
    const reconciled = launch(["stop", repo, "--json"]);
    assert.equal(await reconciled.done, 0, reconciled.output());
    assert.equal(read().worker, null);
    assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
    evidence.push(
      "supervisor loss retains worker serialization and refuses replacement until drainage",
    );
    freshHome("worker-loss-home");
    fs.unlinkSync(`${fixture}.barrier`);
    configure("hold");
    const workerLost = launch(["exec", repo, "--", "synthetic"]);
    await watchUntil(`${fixture}.barrier`, () => fs.existsSync(`${fixture}.barrier`));
    const workerOwner = read().worker;
    const heldProvider = Number(fs.readFileSync(`${fixture}.barrier`, "utf8"));
    assert.equal(
      Number(run("ps", ["-o", "ppid=", "-p", String(workerOwner.pid)])),
      workerLost.child.pid,
    );
    assert.equal(Number(run("ps", ["-o", "pgid=", "-p", String(heldProvider)])), workerOwner.pid);
    const providerBirth = run("ps", ["-o", "lstart=", "-p", String(heldProvider)]);
    const ownerExited = new Promise<void>((resolve) =>
      workerLost.child.once("exit", () => resolve()),
    );
    // This live child belongs to this invocation, and its held provider remains
    // in its process group. Killing the worker must not establish full drainage.
    process.kill(workerOwner.pid, "SIGKILL");
    await ownerExited;
    expectExit(["exec", repo, "--", "synthetic"], 1);
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
    assert.equal(read().state.operation.drained, false);
    assert.equal(run("ps", ["-o", "lstart=", "-p", String(heldProvider)]), providerBirth);
    assert.equal(Number(run("ps", ["-o", "pgid=", "-p", String(heldProvider)])), workerOwner.pid);
    process.kill(heldProvider, "SIGTERM");
    await workerLost.done;
    expectExit(["stop", repo, "--json"], 0);
    assert.equal(read().worker, null);
    assert.deepEqual(read().state.stopProof, { workloadsStopped: true, routesRemoved: true });
    evidence.push(
      "worker loss refuses replacement while its verified provider group remains active",
    );
    freshHome("devsy-home");
    closedEnv.DEVROUTER_WORKSPACE_RUNTIME = "devsy";
    configure("complete", 3, "devsy");
    expectExit(["exec", repo, "--", "synthetic"], 3);
    assert.equal(read().state.operation.exitCode, 3);
    configure("complete", 0, "devsy");
    expectExit(["exec", repo, "--", "synthetic"], 0);
    assert.equal(read().state.operationHistory.length, 2);
    evidence.push("successive Devsy executions retain separate proven results");
    fs.writeFileSync(journal, "{");
    expectExit(["exec", repo, "--", "synthetic"], 1);
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8")).launches, 1);
    evidence.push("corrupt journal blocks provider dispatch");
    assert.ok(!fs.existsSync(`${fixture}.unexpected`), "Unexpected provider command occurred");
  }
  await races();
  console.log(
    JSON.stringify(
      {
        status: "passed",
        scope: "installed-cli-synthetic-providers",
        liveProviderQualified: false,
        oomQualified: false,
        root,
        sourceRevision,
        dirty,
        node: process.version,
        pnpm: run("pnpm", ["--version"]),
        fixtureVersion: 2,
        tarballSha256: digest(tarball),
        cliSha256: digest(cli),
        workerSha256: digest(worker),
        evidence,
      },
      null,
      2,
    ),
  );
}
main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await Promise.all(
    [...ownedInvocations].map(
      (child) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            console.error(`Fixture child drainage remains unproven: ${child.pid}`);
            resolve();
          }, 5_000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }),
    ),
  );
});
