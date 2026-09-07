import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// All provider invocations resolve to these closed synthetic fixtures. The installed
// package receives a fresh home and no host environment or provider socket.
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qualify-lifecycle-")));
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
  };
  const fixtureSource = `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.LIFECYCLE_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
const fail = () => { fs.appendFileSync(file + '.unexpected', JSON.stringify({command,args})+'\\n'); process.exit(90); };
const write = () => fs.writeFileSync(file, JSON.stringify(state));
if (command === 'devpod' && args[0] === 'version') { console.log('fixture'); }
else if (command === 'devsy' && args[0] === '--version') { console.log('fixture'); }
else if (command === 'devpod' && args.join(' ') === 'list --output json --skip-pro') { output(state.provider === 'devpod' ? [{id:'fixture',source:{localFolder:state.repo}}] : []); }
else if (command === 'devsy' && args.join(' ') === 'workspace list --result-format json --skip-pro') { output(state.provider === 'devsy' ? [{id:'fixture',source:{localFolder:state.repo}}] : []); }
else if (command === 'devpod' && args.join(' ') === 'up '+state.repo+' --id fixture --open-ide=false') { state.running=true; write(); }
else if (command === 'devpod' && args[0] === 'status' && args[1] === 'fixture') { output({id:'fixture',state:state.running?'Running':'Stopped'}); }
else if (command === 'devsy' && args[0] === 'workspace' && args[1] === 'status' && args[2] === 'fixture') { output({id:'fixture',state:state.running?'Running':'Stopped'}); }
else if (command === 'docker' && args.join(' ') === 'context show') console.log('fixture');
else if (command === 'docker' && args[0] === 'context' && args[1] === 'inspect' && args[2] === 'fixture') console.log('unix://'+file+'.sock');
else if (command === 'docker' && args.join(' ') === 'exec '+'a'.repeat(64)+' git -C /workspace rev-parse --show-toplevel') console.log('/workspace');
else if (command === 'docker' && args.join(' ') === 'compose -f '+process.env.HOME+'/.config/devrouter/compose.yml up -d') { }
else if (command === 'docker' && args[0] === 'ps' && args.includes('{{.ID}}')) { console.log('a'.repeat(64)); }
else if (command === 'docker' && args[0] === 'inspect' && args.at(-1) === 'a'.repeat(64) && args[1] === '--format') {
 output({id:'a'.repeat(64),state:{Running:state.running,Status:state.running?'running':'exited',Paused:false,Restarting:false,Dead:false},labels:{'com.docker.compose.project':'fixture','com.docker.compose.service':'app','com.docker.compose.project.working_dir':state.repo+'/.devcontainer','com.docker.compose.project.config_files':state.repo+'/.devcontainer/compose.yml','com.docker.compose.config-hash':'fixture'},mounts:[{Type:'bind',Source:state.repo,Destination:'/workspace'}],networks:{}});
}
else if ((command === 'devpod' && args[2] === 'ssh' && args[3] === 'fixture') || (command === 'devsy' && args[0] === 'workspace' && args[1] === 'exec' && args[4] === 'fixture')) {
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
else if ((command==='devpod' && args[0]==='stop' && args[1]==='fixture') || (command==='devsy' && args[0]==='workspace' && args[1]==='stop' && args[2]==='fixture')) { state.running=false; write(); }
else fail();
`;
  for (const command of ["docker", "devpod", "devsy", "mkcert"])
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
    const apiRequests: string[] = [];
    const server = http.createServer((request, response) => {
      apiRequests.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/networks/devnet") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ Name: "devnet" }));
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
        status: "partial",
        root,
        sourceRevision,
        dirty,
        node: process.version,
        pnpm: run("pnpm", ["--version"]),
        fixtureVersion: 1,
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
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
