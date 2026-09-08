import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { build } from "tsup";
import { createReliabilityState, reliabilityFence } from "../src/core/reliability-contract";
import { stepReliability } from "../src/core/reliability-model";
import { capacityEstimatesDigest } from "../src/core/repo-config";

async function main() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "dr-cap-"));
  console.error(`Synthetic capacity qualification artifacts: ${root}`);
  const source = process.cwd();
  const node = fs.realpathSync(process.execPath);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const control = path.join(root, "repo");
  const router = path.join(home, ".config/devrouter");
  const directory = path.join(router, "controller");
  for (const dir of [home, bin, control, directory, path.join(router, "reliability")])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const run = (command: string, args: string[], cwd = source, env = process.env) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const sourceRevision = run("git", ["rev-parse", "HEAD"]);
  const dirty = run("git", ["status", "--porcelain"]) !== "";
  run("pnpm", ["build"]);
  run("pnpm", ["pack", "--pack-destination", root]);
  const tarballs = fs.readdirSync(root).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = path.join(root, tarballs[0]);
  const install = path.join(root, "install");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--prefix",
      install,
      tarball,
    ],
    source,
    {
      ...process.env,
      HOME: home,
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: "/dev/null",
    },
  );
  const installed = path.join(install, "node_modules/@devrouter/cli/dist");
  const worker = path.join(installed, "devrouter-lifecycle-worker.js");
  assert.ok(fs.existsSync(worker));
  const workerDigest = sha(fs.readFileSync(worker));
  run("git", ["init", "--quiet", control]);
  run("git", [
    "-C",
    control,
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const common = path.join(control, ".git");
  fs.mkdirSync(path.join(common, "devrouter/workspaces"), { recursive: true });
  const estimates = {
    version: 1 as const,
    profiles: {
      full: {
        host: { steadyBytes: 10, startupTotalBytes: 20 },
        runtime: { steadyBytes: 10, startupTotalBytes: 20 },
        operations: { synthetic: { hostIncrementBytes: 0, runtimeIncrementBytes: 1 } },
      },
    },
  };
  const entries = ["one", "two"].map((name, index) => {
    const repo = path.join(control, "trees", name);
    run("git", ["-C", control, "worktree", "add", "-b", name, repo]);
    const gitDir = run("git", ["-C", repo, "rev-parse", "--absolute-git-dir"]);
    fs.writeFileSync(path.join(gitDir, "devrouter-workspace"), `${name}\n`);
    fs.writeFileSync(
      path.join(common, "devrouter/workspaces", `${name}.json`),
      JSON.stringify({
        version: 1,
        workspace: name,
        worktreePath: repo,
        devpodId: name,
        branch: name,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    fs.writeFileSync(
      path.join(repo, ".devrouter.yml"),
      JSON.stringify({
        version: 1,
        apps: [],
        managedRuntime: { devcontainer: { baseServices: [], profileServices: [] }, processes: [] },
        profiles: { full: { apps: ["*"], processes: ["*"], default: true } },
        capacity: estimates,
      }),
    );
    const devcontainer = path.join(repo, ".devcontainer");
    fs.mkdirSync(devcontainer);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".devcontainer/devcontainer.devrouter.json\n");
    fs.writeFileSync(
      path.join(devcontainer, "compose.yml"),
      "services:\n  app:\n    image: synthetic\n",
    );
    fs.writeFileSync(
      path.join(devcontainer, "docker-compose.devrouter.yml"),
      "services:\n  app: {}\n",
    );
    fs.writeFileSync(
      path.join(devcontainer, "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: ["compose.yml", "docker-compose.devrouter.yml"],
        service: "app",
        runServices: ["app"],
        workspaceFolder: "/workspace",
      }),
    );
    fs.writeFileSync(
      path.join(devcontainer, "post-start.sh"),
      '# devrouter:managed devcontainer\n: "$DEVROUTER_PROCESS_HELPER"\n',
    );
    let state = createReliabilityState(sha(repo), 0, "manual");
    state = stepReliability(state, { ...reliabilityFence(state), type: "stop" }, 1).state;
    state = stepReliability(
      state,
      {
        ...reliabilityFence(state),
        type: "stop-proof",
        workloadsStopped: true,
        routesRemoved: true,
      },
      2,
    ).state;
    fs.writeFileSync(
      path.join(router, "reliability", `${sha(repo)}.json`),
      JSON.stringify({
        version: 1,
        identity: { repoPath: repo, workspace: name, provider: "devpod" },
        revision: 1,
        state,
        worker: null,
        effectSequence: 0,
        outcome: null,
      }),
      { mode: 0o600 },
    );
    return { name, repo, id: String(index + 1).repeat(64), running: false, starts: 0 };
  });
  const endpoint = path.join(root, "docker.sock");
  const fixture = path.join(root, "provider.json");
  fs.writeFileSync(fixture, JSON.stringify(entries));
  const budget = { capacityBytes: 100, protectedHeadroomBytes: 10, startupSlots: 1, heavySlots: 1 };
  fs.writeFileSync(
    path.join(directory, "capacity-policy.json"),
    JSON.stringify({
      version: 1,
      revision: 1,
      admissions: "enabled",
      scheduling: {
        maxQueuedPerDomain: 2,
        maxQueuedTotal: 2,
        queueLifetimeSeconds: 900,
        clientWaitSeconds: 1,
        maxClientWaitSeconds: 30,
        watchSeconds: 30,
        sampleIntervalSeconds: 5,
        maxSampleAgeSeconds: 15,
      },
      domains: {
        host: { kind: "host", adapter: "macos-host-v1", ...budget },
        runtime: {
          kind: "runtime",
          adapter: "orbstack-local-v1",
          endpoint,
          daemonId: "synthetic-daemon",
          hostDomain: "host",
          hostChargeCeilingBytes: 60,
          ...budget,
        },
      },
      enrollments: entries.map((entry) => ({
        repoPath: entry.repo,
        gitCommonDir: common,
        workspace: entry.name,
        provider: "devpod",
        providerId: entry.name,
        hostDomain: "host",
        runtimeDomain: "runtime",
        profiles: ["full"],
        estimatesDigest: capacityEstimatesDigest(estimates),
        defaultOperation: { hostIncrementBytes: 0, runtimeIncrementBytes: 1 },
      })),
    }),
    { mode: 0o600 },
  );
  // This fixture executable is never shipped or selected by production configuration.
  const provider = `#!${node}
const fs=require('node:fs'),path=require('node:path');
const file=${JSON.stringify(fixture)}, entries=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2),command=path.basename(process.argv[1]);
const output=x=>console.log(JSON.stringify(x));
const fail=()=>{fs.appendFileSync(file+'.unexpected',JSON.stringify({command,args})+'\\n');process.exit(90)};
const found=entries.find(e=>args.includes(e.id)||args.includes(e.name)||args.includes(e.repo));
const save=()=>fs.writeFileSync(file,JSON.stringify(entries));
const inspect=e=>({id:e.id,state:{Running:e.running,Status:e.running?'running':'exited',Paused:false,Restarting:false,Dead:false},labels:{'com.docker.compose.project':e.name,'com.docker.compose.service':'app','com.docker.compose.project.working_dir':e.repo+'/.devcontainer','com.docker.compose.project.config_files':e.repo+'/.devcontainer/compose.yml,'+e.repo+'/.devcontainer/docker-compose.devrouter.yml','com.docker.compose.config-hash':'0'.repeat(64)},mounts:[{Type:'bind',Source:e.repo,Destination:'/workspace'},{Type:'bind',Source:${JSON.stringify(common)},Destination:${JSON.stringify(common)}}],networks:{devnet:{Aliases:[e.name+'-app']}}});
if(command==='devpod'&&args.join(' ')==='list --output json --skip-pro')output(entries.map(e=>({id:e.name,source:{localFolder:e.repo}})));
else if(command==='devsy'&&args.join(' ')==='workspace list --result-format json --skip-pro')output([]);
else if(command==='devpod'&&args[0]==='version')console.log('synthetic');
else if(command==='devsy'&&args[0]==='--version')console.log('synthetic');
else if(command==='devpod'&&args[0]==='status'&&found)output({id:found.name,state:found.running?'Running':'Stopped'});
else if(command==='devpod'&&args[0]==='up'&&found&&JSON.stringify(args)===JSON.stringify(['up',found.repo,'--id',found.name,'--devcontainer-path','.devcontainer/devcontainer.devrouter.json','--open-ide=false','--workspace-env','WORKSPACE='+found.name,'--workspace-env','DEVROUTER_WORKSPACE='+found.name])){
 const snapshot=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(directory, "capacity-reservations.json"))},'utf8'));
 if(!snapshot.pools?.length||!snapshot.reservations.some(r=>r.environmentId===require('node:crypto').createHash('sha256').update(found.repo).digest('hex')&&r.startup))fail();
 found.starts++;save();fs.writeFileSync(file+'.launch-'+found.name,JSON.stringify({pid:process.pid,snapshot}));
 const complete=()=>{found.running=true;save()};
 if(found.name==='one'&&!fs.existsSync(file+'.release')){const watch=fs.watch(path.dirname(file),()=>{if(fs.existsSync(file+'.release')){watch.close();complete()}})}else complete();
}
else if(command==='devpod'&&args[0]==='stop'&&found){found.running=false;save()}
else if(command==='docker'&&args.join(' ')==='context show')console.log('synthetic');
else if(command==='docker'&&JSON.stringify(args)===JSON.stringify(['context','inspect','synthetic','--format','{{ .Endpoints.docker.Host }}']))console.log(${JSON.stringify(`unix://${endpoint}`)});
else if(command==='docker'&&args[0]==='ps'&&args.includes('{{.ID}}')){
 const filter=args.find(a=>a.startsWith('label=com.docker.compose.project='));
 console.log(entries.filter(e=>!filter||filter.endsWith('='+e.name)).map(e=>e.id).join('\\n'));
}
else if(command==='docker'&&args[0]==='inspect'&&args[1]==='--format'&&args.slice(3).every(id=>entries.some(e=>e.id===id)))args.slice(3).forEach(id=>output(inspect(entries.find(e=>e.id===id))));
else if(command==='docker'&&args[0]==='exec'&&found&&args[2]==='git'&&args.slice(3).join(' ')==='-C /workspace rev-parse --show-toplevel')console.log('/workspace');
else if(command==='docker'&&args[0]==='exec'&&found&&args[2]==='printenv'&&['WORKSPACE','DEVROUTER_WORKSPACE'].includes(args[3]))console.log(found.name);
else if(command==='docker'&&args[0]==='exec'&&args[1]==='-i'&&found&&args[3]==='sh'){fs.readFileSync(0)}
else if(command==='docker'&&args[0]==='exec'&&found&&args.includes('DEVROUTER_PROCESS_SET=')&&args.includes('.devcontainer/post-start.sh')){}
else if(command==='docker'&&args[0]==='compose'&&args.includes('--services')&&args.includes('--no-env-resolution'))console.log('app');
else if(command==='docker'&&args[0]==='compose'&&args.includes('--hash')&&args.at(-1)==='app'){fs.readFileSync(0);console.log('app '+'0'.repeat(64))}
else if(command==='docker'&&args[0]==='compose'&&args.includes('config')&&args.at(-1)==='json')output({services:{app:{image:'synthetic'}}});
else if(command==='docker'&&args.join(' ')==='compose -f '+process.env.HOME+'/.config/devrouter/compose.yml up -d'){}
else fail();
`;
  for (const command of ["docker", "devpod", "devsy", "mkcert", "curl"])
    fs.writeFileSync(path.join(bin, command), provider, { mode: 0o700 });
  const entry = path.join(root, "capacity-tracer-entry.ts");
  fs.writeFileSync(
    entry,
    `// Observe IPC results without replacing the installed worker or its lifecycle.
const childProcess = require('node:child_process');
const fork = childProcess.fork;
childProcess.fork = (...args) => { const child = fork(...args); child.on('message', message => { console.error(JSON.stringify({workerMessage:message})); if(message.ok===false)require('node:fs').writeFileSync(${JSON.stringify(`${fixture}.worker-error`)},message.message); }); return child; };
import {runControllerCommand} from ${JSON.stringify(path.join(source, "src/commands/controller"))};\nimport {createCapacityController} from ${JSON.stringify(path.join(source, "src/core/capacity-controller"))};\nvoid runControllerCommand('run',{},undefined,{createOperations:controller=>{
  const operations=createCapacityController({directory:controller.directory,controller,collect:async signal=>{if(signal.aborted)throw new Error('cancelled');const sample={sampledAtMs:Date.now(),pressure:'normal' as const,unmanagedBytes:0,sharedBytes:0,ownedBytes:{}};return {host:sample,runtime:sample}}});
  const watch=operations.watch;
  operations.watch=async (request,environment,signal)=>{
    if(request.timeout!==30)return watch(request,environment,signal);
    require('node:fs').writeFileSync(${JSON.stringify(`${fixture}.watching`)},request.operationId);
    try { return await watch(request,environment,signal); }
    finally { if(signal.aborted)require('node:fs').writeFileSync(${JSON.stringify(`${fixture}.watch-cancelled`)},request.operationId); }
  };
  return operations;
}});\n`,
  );
  await build({
    entry: [entry],
    outDir: installed,
    format: ["cjs"],
    target: "node24",
    clean: false,
    splitting: false,
    config: false,
    silent: true,
  });
  const bundled = path.join(installed, "capacity-tracer-entry.js");
  assert.equal(sha(fs.readFileSync(worker)), workerDigest);
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    LC_ALL: "C",
    DEVROUTER_WORKSPACE_RUNTIME: "devpod",
    DOCKER_HOST: `unix://${endpoint}`,
    NODE_PATH: path.join(install, "node_modules"),
    NODE_OPTIONS: "",
  };
  const api = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/info")
      response.end(JSON.stringify({ ID: "synthetic-daemon", MemTotal: 100 }));
    else if (request.method === "GET" && request.url === "/networks/devnet")
      response.end(JSON.stringify({ Name: "devnet" }));
    else {
      fs.appendFileSync(`${fixture}.unexpected`, `${request.method} ${request.url}\n`);
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    api.once("error", reject);
    api.listen(endpoint, resolve);
  });
  let child: ChildProcess | undefined;
  const sockets: net.Socket[] = [];
  const waitFor = (predicate: () => boolean, label: string, timeout = 20_000) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        try {
          if (fs.existsSync(`${fixture}.worker-error`))
            throw new Error(fs.readFileSync(`${fixture}.worker-error`, "utf8"));
          if (predicate()) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          clearInterval(interval);
          clearTimeout(timer);
          reject(error);
        }
      };
      const interval = setInterval(check, 50);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`Timed out: ${label}`));
      }, timeout);
      check();
    });
  function connect() {
    const socket = net.createConnection(path.join(directory, "control.sock"));
    sockets.push(socket);
    let buffer = "";
    type Result = {
      store: string;
      epoch: number;
      generation: string;
      operation: { operationId: string; phase: string };
    };
    let deliver: ((value: { ok: boolean; result: Result }) => void) | undefined;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const value = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        deliver?.(value);
      }
    });
    return {
      socket,
      request: (value: object) =>
        new Promise<Result>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Synthetic client response timed out."));
          }, 10_000);
          const closed = () => {
            cleanup();
            reject(new Error("Synthetic client disconnected."));
          };
          const cleanup = () => {
            clearTimeout(timeout);
            socket.removeListener("close", closed);
            deliver = undefined;
          };
          socket.once("close", closed);
          deliver = (reply) => {
            cleanup();
            if (!reply.ok) reject(new Error(`${JSON.stringify(value)}: ${JSON.stringify(reply)}`));
            else resolve(reply.result);
          };
          socket.write(`${JSON.stringify({ version: 1, id: "request", ...value })}\n`);
        }),
    };
  }
  try {
    const log = fs.openSync(path.join(root, "controller.log"), "w", 0o600);
    child = spawn(node, [bundled], { env, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    await waitFor(() => {
      if (child?.exitCode !== null) throw new Error("Fixture controller exited.");
      return fs.existsSync(path.join(directory, "control.sock"));
    }, "controller socket");
    const clients = [connect(), connect()];
    const bindings = [];
    for (const [index, client] of clients.entries()) {
      await client.request({ method: "handshake" });
      const result = await client.request({
        method: "observe",
        path: entries[index].repo,
        session: entries[index].name,
        profile: "full",
        require: ["runtime"],
      });
      bindings.push({
        session: entries[index].name,
        store: result.store,
        epoch: result.epoch,
        generation: result.generation,
      });
    }
    const first = await clients[0].request({
      method: "operation-submit",
      ...bindings[0],
      requestId: "first",
      kind: "ensure",
    });
    const second = await clients[1].request({
      method: "operation-submit",
      ...bindings[1],
      requestId: "second",
      kind: "ensure",
    });
    await waitFor(
      () => fs.existsSync(`${fixture}.launch-one`),
      "first real worker provider launch",
    );
    const pending = await clients[1].request({
      method: "operation-watch",
      ...bindings[1],
      operationId: second.operation.operationId,
      timeout: 0,
    });
    assert.equal(pending.operation.phase, "queued");
    assert.equal(pending.operation.operationId, second.operation.operationId);
    const queued = JSON.parse(
      fs.readFileSync(path.join(router, "reliability", `${sha(entries[1].repo)}.json`), "utf8"),
    );
    assert.equal(queued.state.operation.id, second.operation.operationId);
    assert.equal(queued.state.phase, "queued");
    assert.equal(queued.state.admission, "waiting");
    const waiting = clients[0]
      .request({
        method: "operation-watch",
        ...bindings[0],
        operationId: first.operation.operationId,
        timeout: 30,
      })
      .catch(() => {});
    await waitFor(() => fs.existsSync(`${fixture}.watching`), "accepted operation watch");
    clients[0].socket.destroy();
    await waiting;
    await waitFor(() => fs.existsSync(`${fixture}.watch-cancelled`), "disconnected watch drained");
    assert.equal(JSON.parse(fs.readFileSync(fixture, "utf8"))[0].starts, 1);
    assert.equal(fs.existsSync(`${fixture}.launch-two`), false);
    fs.writeFileSync(`${fixture}.release`, "release");
    await waitFor(
      () => fs.existsSync(`${fixture}.launch-two`),
      "settlement followed by second real worker launch",
    );
    await waitFor(() => {
      const records = entries.map((e) =>
        JSON.parse(
          fs.readFileSync(path.join(router, "reliability", `${sha(e.repo)}.json`), "utf8"),
        ),
      );
      return records.every(
        (r) => r.state.operation?.status === "COMPLETED" && r.state.operation.drained,
      );
    }, "both workers complete and drain");
    const final = JSON.parse(fs.readFileSync(fixture, "utf8"));
    assert.deepEqual(
      final.map((entry: { starts: number }) => entry.starts),
      [1, 1],
    );
    const secondLaunch = JSON.parse(fs.readFileSync(`${fixture}.launch-two`, "utf8"));
    assert.equal(
      secondLaunch.snapshot.reservations.find(
        (r: { operationId: string }) => r.operationId === first.operation.operationId,
      ).startup,
      false,
    );
    assert.equal(secondLaunch.snapshot.pools.length, 1);
    assert.ok(!fs.existsSync(`${fixture}.unexpected`));
    assert.equal(sha(fs.readFileSync(worker)), workerDigest);
    const receipt = {
      sourceRevision,
      dirty,
      tarballSha256: sha(fs.readFileSync(tarball)),
      fixtureBundleSha256: sha(fs.readFileSync(bundled)),
      installedWorkerSha256: workerDigest,
      launches: [1, 1],
      secondQueuedIdPreserved: true,
      disconnectedWatcherDidNotCancel: true,
      positivePreparationSettlement: true,
      boundary:
        "Fixture-injected coordinator bundle and actual installed lifecycle worker; not ordinary CLI capacity activation or live runtime/OOM proof.",
    };
    const receiptPath = path.join(root, "receipt.json");
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(receiptPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child && child.exitCode === null) {
      const owned = child;
      const stopped = new Promise<void>((resolve) => {
        const force = setTimeout(() => owned.kill("SIGKILL"), 5_000);
        owned.once("close", () => {
          clearTimeout(force);
          resolve();
        });
      });
      owned.kill("SIGTERM");
      await stopped;
    }
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
