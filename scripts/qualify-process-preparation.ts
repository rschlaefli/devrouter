/**
 * Qualify preparation reuse for repository-owned processes in a routed consumer.
 *
 * The fixture is a disposable checkout under DR_PREPARATION_ROOT whose managed
 * devcontainer runs one repository-owned process. That process serves the
 * checkout's HTTP route through a devnet alias, and the repository adapter passes
 * `--prepare-command` to `devrouter-process ensure`. Six cohorts run on that one
 * workload, in order, so their numbers stay comparable:
 *
 *   cold                the first ensure creates the container, prepares once and
 *                       launches the process that answers the route
 *   unchanged-reuse     a second ensure keeps the live owned process and skips
 *                       preparation
 *   runtime-change      changed adapter identity stops the owned group, prepares
 *                       again and launches the new process
 *   stopped-resume      a non-destructive stop retains the container; the next
 *                       ensure prepares again because no owned process survived
 *   unknown-ownership   a removed helper record must make ensure refuse instead of
 *                       duplicating or killing the unowned process
 *   recovery            the documented stop-then-ensure path restores the runtime
 *   pruned-population   an external prune removes the container while the Devsy
 *                       registration survives, and stop must prove the absent
 *                       population instead of demanding the container it lost
 *
 * Each cohort records wall time, the streamed phase timeline, peak CLI resident
 * memory, the container's memory at readiness and its first-attempt exit code.
 * Preparation runs and adapter invocations are counted inside the container, the
 * helper's recorded process identity is read from its own state file, and the
 * published route is fetched over the machine's real TLS setup as an independent
 * readiness proof. Nothing is retried: a first-attempt failure is evidence, not
 * noise.
 *
 * The machine's real HOME is used on purpose, like an operator session, so the
 * real provider state and reliability journal are in play. The fixture path is
 * stable, so repeated runs reuse one journal record; that record survives the
 * final delete and its exact path is part of the evidence.
 *
 * Exit codes: 0 every assertion held, 1 an assertion failed, 3 a prerequisite was
 * unavailable and no cohort ran. A skip is not a pass.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREP_LOG = "/tmp/devrouter-preparation.log";
const ADAPTER_LOG = "/tmp/devrouter-preparation-adapter.log";
const APP_LOG = "/tmp/devrouter-preparation-app.log";
const HELPER_STATE = "/tmp/devrouter-process-app.state";
// One fixture directory is one environment: the project token that ${WORKSPACE}
// resolves to, the devnet aliases and the route host all derive from this id, so
// a fixture left running from an older revision cannot collide with this run's
// alias or route.
const FIXTURE_ID = "preparation-consumer";
const ROUTE_HOST = `prep-${FIXTURE_ID}.localhost`;
const APP_PORT = 3000;
const IMAGE_TAG = "devrouter-preparation-consumer:local";
const PREPARE_MILLIS = 2000;

type RunEvent = {
  kind: "progress" | "provider-status" | "provider-result";
  phase: string;
  role?: string;
  started?: boolean;
  atMs: number;
};

type Timeline = {
  progress: Array<{ phase: string; role?: string; atMs: number }>;
  provider: Array<{ phase: string; startedAtMs: number; durationMs?: number }>;
};

type RunResult = {
  args: string[];
  exitCode: number | null;
  runMs: number;
  peakRssKiB: number;
  events: RunEvent[];
  payload: Record<string, unknown> | undefined;
  stderrTail: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command: string, args: string[], cwd?: string, timeout = 120_000) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout });
}

function requireOk(result: ReturnType<typeof run>, command: string, args: string[]) {
  assert.equal(
    result.status,
    0,
    `Fixture command failed: ${command} ${args.join(" ")}: ${(result.stderr ?? "").trim()}`,
  );
  return result.stdout.trim();
}

function skip(reason: string): never {
  process.stdout.write(`Process-preparation qualification skipped: ${reason}\n`);
  process.exit(3);
}

function deriveTimeline(events: RunEvent[]): Timeline {
  const progress: Timeline["progress"] = [];
  const provider: Timeline["provider"] = [];
  const open = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "progress") {
      progress.push({ phase: event.phase, role: event.role, atMs: event.atMs });
    } else if (event.kind === "provider-status") {
      if (event.started) {
        open.set(event.phase, provider.length);
        provider.push({ phase: event.phase, startedAtMs: event.atMs });
      } else {
        const index = open.get(event.phase);
        if (index !== undefined) {
          open.delete(event.phase);
          const entry = provider[index];
          if (entry) entry.durationMs = event.atMs - entry.startedAtMs;
        }
      }
    }
  }
  return { progress, provider };
}

function renderAdapter(generation: string) {
  return [
    "#!/usr/bin/env bash",
    "# devrouter:managed devcontainer",
    "set -euo pipefail",
    "",
    ': "${DEVROUTER_PROCESS_HELPER:?Run devrouter ensure to start this managed application process.}"',
    `printf 'start %s\\n' "$(date +%s%N)" >> ${ADAPTER_LOG}`,
    '"$DEVROUTER_PROCESS_HELPER" ensure \\',
    "  --name app \\",
    "  --match 'node server.js' \\",
    `  --log ${APP_LOG} \\`,
    `  --prepare-command 'sleep ${PREPARE_MILLIS / 1000} && date +%s%N >> ${PREP_LOG}' \\`,
    `  -- node server.js --generation ${generation}`,
    `printf 'end %s\\n' "$(date +%s%N)" >> ${ADAPTER_LOG}`,
    "",
  ].join("\n");
}

async function main() {
  const source = process.cwd();
  const dist = path.resolve(
    process.env.DR_PREPARATION_DIST ?? path.join(source, "dist/devrouter.js"),
  );
  if (!fs.existsSync(dist)) skip("build dist/devrouter.js first (pnpm build).");
  const docker = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (docker.status !== 0) skip("docker is unavailable.");
  const devsy = run("devsy", ["--version"]);
  if (devsy.status !== 0) skip("the devsy provider is unavailable.");
  const node = fs.realpathSync(process.execPath);
  const root = path.join(
    fs.realpathSync(process.env.DR_PREPARATION_ROOT ?? os.tmpdir()),
    "devrouter-process-preparation",
  );
  fs.mkdirSync(root, { recursive: true });
  // The provider derives its workspace id from this folder's basename, so the
  // name must stay unique per qualification fixture; a shared basename makes a
  // run attach and mutate another fixture's container instead of its own.
  const fixture = path.join(root, FIXTURE_ID);
  const workspaceFolder = "/workspaces/process-preparation";
  const evidencePath = process.env.DR_PREPARATION_EVIDENCE ?? path.join(root, "evidence.json");
  const journalFile = path.join(
    os.homedir(),
    ".config",
    "devrouter",
    "reliability",
    `${sha256(fixture)}.json`,
  );
  const routesFile = path.join(os.homedir(), ".config", "devrouter", "host-routes-state.json");
  const mkcertRoot = run("mkcert", ["-CAROOT"]);
  const rootCa = path.join(mkcertRoot.stdout.trim(), "rootCA.pem");
  const caFile = mkcertRoot.status === 0 && fs.existsSync(rootCa) ? rootCa : undefined;
  const revision = run("git", ["rev-parse", "HEAD"], source);
  const dirty = run("git", ["status", "--porcelain"], source);

  function dockerOut(args: string[]) {
    return requireOk(run("docker", args), "docker", args);
  }

  function containerIdFor(checkout: string) {
    const ids = dockerOut(["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean);
    for (const id of ids) {
      const mounts = run("docker", [
        "inspect",
        "-f",
        "{{range .Mounts}}{{println .Source}}{{end}}",
        id,
      ]);
      if (mounts.status === 0 && mounts.stdout.split("\n").includes(checkout)) return id;
    }
    return undefined;
  }

  function containerState(id: string) {
    const raw = dockerOut([
      "inspect",
      "-f",
      "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
      id,
    ]);
    const [status, exitCode, oomKilled] = raw.split(" ");
    return { status, exitCode: Number(exitCode), oomKilled: oomKilled === "true" };
  }

  function containerMemory(id: string) {
    const result = run("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", id]);
    return result.status === 0 ? result.stdout.trim() : "unknown";
  }

  function execIn(id: string, script: string) {
    return requireOk(run("docker", ["exec", id, "sh", "-c", script]), "docker exec", [script]);
  }

  function preparationRuns(id: string) {
    return execIn(id, `cat ${PREP_LOG} 2>/dev/null || true`)
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  }

  function adapterStats(id: string) {
    const lines = execIn(id, `cat ${ADAPTER_LOG} 2>/dev/null || true`)
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const durationsMs: number[] = [];
    let startedAtNs: number | undefined;
    let invocations = 0;
    let completions = 0;
    for (const line of lines) {
      const [kind, value] = line.trim().split(/\s+/);
      const timestamp = Number(value);
      if (kind === "start" && Number.isFinite(timestamp)) {
        invocations += 1;
        startedAtNs = timestamp;
        continue;
      }
      if (kind === "end" && Number.isFinite(timestamp)) {
        completions += 1;
        if (startedAtNs !== undefined) {
          durationsMs.push(Math.round((timestamp - startedAtNs) / 1_000_000));
        }
        startedAtNs = undefined;
      }
    }
    return { invocations, completions, durationsMs };
  }

  function helperRecord(id: string) {
    const raw = execIn(id, `cat ${HELPER_STATE} 2>/dev/null || true`).trim();
    if (raw.length === 0) return undefined;
    const [pid, pgid, fingerprint] = raw.split(/\s+/);
    return { pid: Number(pid), pgid: Number(pgid), fingerprint };
  }

  function processFacts(id: string, pid: number | undefined) {
    if (pid === undefined || !Number.isFinite(pid)) {
      return { pid, alive: false, cmdline: "", matches: 0 };
    }
    const alive = execIn(id, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`) === "alive";
    const cmdline = alive
      ? execIn(id, `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null || true`).trim()
      : "";
    // Build the match pattern at runtime so this shell never matches itself.
    const count = execIn(
      id,
      [
        "pattern=$(printf 'node %s %s' 'server.js' '--generation')",
        "count=0",
        "for entry in /proc/[0-9]*; do",
        '  [ -r "$entry/cmdline" ] || continue',
        "  if tr '\\0' ' ' < \"$entry/cmdline\" | grep -q -- \"$pattern\"; then count=$((count+1)); fi",
        "done",
        'echo "$count"',
      ].join("\n"),
    );
    return { pid, alive, cmdline, matches: Number(count.trim()) };
  }

  function journalState() {
    if (!fs.existsSync(journalFile)) return undefined;
    const parsed = asRecord(JSON.parse(fs.readFileSync(journalFile, "utf8")));
    const state = asRecord(parsed?.state);
    return {
      revision: typeof parsed?.revision === "number" ? parsed.revision : undefined,
      phase: text(state?.phase),
      desired: text(state?.desired),
    };
  }

  function routeEntry() {
    if (!fs.existsSync(routesFile)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(routesFile, "utf8"));
    if (!Array.isArray(parsed)) return undefined;
    for (const entry of parsed) {
      const record = asRecord(entry);
      if (record?.host === ROUTE_HOST) {
        return {
          host: ROUTE_HOST,
          mode: text(record.mode),
          upstreamHost: text(record.upstreamHost),
          workspace: text(record.workspace),
        };
      }
    }
    return undefined;
  }

  function runDevrouter(args: string[]) {
    return new Promise<RunResult>((resolve, reject) => {
      const started = performance.now();
      const child: ChildProcess = spawn(node, [dist, ...args], {
        cwd: fixture,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const events: RunEvent[] = [];
      let peakRssKiB = 0;
      const buffers = { stdout: "", stderr: "" };
      const stderrLines: string[] = [];
      let pending = "";
      const sampler = setInterval(() => {
        if (!child.pid || child.exitCode !== null) return;
        const sample = run("ps", ["-o", "rss=", "-p", String(child.pid)]);
        const value = Number(sample.stdout.trim());
        if (Number.isFinite(value) && value > 0) peakRssKiB = Math.max(peakRssKiB, value);
      }, 150);
      // Lifecycle progress and provider status are written to stderr so stdout
      // stays the machine-readable payload; both streams are ingested.
      function record(line: string, stream: "stdout" | "stderr") {
        const atMs = Math.round(performance.now() - started);
        if (!line.startsWith("{")) {
          if (stream === "stdout") pending += `${line}\n`;
          else stderrLines.push(line);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          if (stream === "stdout") pending += `${line}\n`;
          else stderrLines.push(line);
          return;
        }
        const payload = asRecord(parsed);
        if (payload?.type === "lifecycle-progress") {
          const phase = text(payload.phase);
          if (phase) events.push({ kind: "progress", phase, role: text(payload.role), atMs });
          return;
        }
        if (payload?.kind === "status") {
          const phase = text(payload.phase);
          if (phase) {
            events.push({
              kind: "provider-status",
              phase,
              started: payload.started === true,
              atMs,
            });
          }
          return;
        }
        if (payload?.kind === "result") {
          events.push({
            kind: "provider-result",
            phase: text(payload.outcome) ?? "unknown",
            atMs,
          });
          return;
        }
        if (stream === "stdout") pending += `${line}\n`;
        else stderrLines.push(line);
      }
      function consume(chunk: Buffer, stream: "stdout" | "stderr") {
        buffers[stream] += chunk.toString("utf8");
        const split = buffers[stream].split("\n");
        buffers[stream] = split.pop() ?? "";
        for (const line of split) record(line, stream);
      }
      child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
      child.once("error", (error) => {
        clearInterval(sampler);
        reject(error);
      });
      child.once("close", (code) => {
        clearInterval(sampler);
        for (const stream of ["stdout", "stderr"] as const) {
          if (buffers[stream]) record(buffers[stream], stream);
        }
        let payload: Record<string, unknown> | undefined;
        const tail = pending.trim();
        if (tail.length > 0) {
          try {
            payload = asRecord(JSON.parse(tail));
          } catch {
            payload = undefined;
          }
        }
        resolve({
          args,
          exitCode: code,
          runMs: Math.round(performance.now() - started),
          peakRssKiB,
          events,
          payload,
          stderrTail: stderrLines.slice(-4).join("\n"),
        });
      });
    });
  }

  function cohort(label: string, result: RunResult) {
    return {
      label,
      args: result.args,
      exitCode: result.exitCode,
      firstAttemptOk: result.exitCode === 0,
      runMs: result.runMs,
      peakRssKiB: result.peakRssKiB,
      payload: result.payload,
      timeline: deriveTimeline(result.events),
    };
  }

  function observe(id: string) {
    const record = helperRecord(id);
    return {
      container: containerState(id),
      memory: containerMemory(id),
      adapter: adapterStats(id),
      preparations: preparationRuns(id),
      helper: record,
      process: processFacts(id, record?.pid),
      journal: journalState(),
      route: routeEntry(),
    };
  }

  function routeUrls(payload: Record<string, unknown> | undefined) {
    const urls = payload?.urls;
    if (!Array.isArray(urls)) return [];
    return urls.filter((value): value is string => typeof value === "string");
  }

  function fetchRoute(url: string, timeoutMs = 5) {
    const args = ["-sS", "--max-time", String(timeoutMs), "-o", "-", "-w", "\n%{http_code}"];
    if (url.startsWith("https://") && caFile) args.push("--cacert", caFile);
    args.push(url);
    const result = run("curl", args, undefined, 30_000);
    const body = result.stdout ?? "";
    const index = body.lastIndexOf("\n");
    const code = index === -1 ? "" : body.slice(index + 1).trim();
    return {
      status: result.status === 0 ? Number(code) : 0,
      code: code || "none",
      body: index === -1 ? "" : body.slice(0, index),
      error: (result.stderr ?? "").trim(),
    };
  }

  async function waitForRoute(url: string, expectGeneration: string) {
    const attempts: Array<Record<string, unknown>> = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const response = fetchRoute(url);
      let body: Record<string, unknown> | undefined;
      try {
        body = asRecord(JSON.parse(response.body));
      } catch {
        body = undefined;
      }
      const hit = {
        attempt,
        status: response.status,
        code: response.code,
        error: response.error,
        pid: body?.pid,
        generation: text(body?.generation),
      };
      attempts.push(hit);
      if (response.status === 200 && hit.generation === expectGeneration) {
        return { url, ok: true, attempts };
      }
      if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { url, ok: false, attempts };
  }

  function writeFixture(generation: string) {
    fs.mkdirSync(path.join(fixture, ".devcontainer"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, ".gitignore"),
      [
        ".devcontainer/devcontainer.devrouter.json",
        ".devcontainer/docker-compose.devrouter-network.yml",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fixture, ".devrouter.yml"),
      [
        "version: 1",
        "project:",
        `  name: ${FIXTURE_ID}`,
        "managedRuntime:",
        "  devcontainer:",
        "    baseServices: []",
        "    profileServices: []",
        "  processes: [app]",
        "profiles:",
        "  full:",
        "    apps: ['*']",
        "    processes: ['*']",
        "    default: true",
        "apps:",
        "  - name: web",
        `    host: ${ROUTE_HOST}`,
        "    protocol: http",
        "    runtime: proxy",
        "    upstream: ${WORKSPACE}-app:3000",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fixture, ".devcontainer/devcontainer.json"),
      `${JSON.stringify(
        {
          name: "devrouter-process-preparation",
          dockerComposeFile: "docker-compose.yml",
          service: "app",
          workspaceFolder,
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(fixture, ".devcontainer/docker-compose.yml"),
      [
        "services:",
        "  app:",
        `    image: ${IMAGE_TAG}`,
        "    init: true",
        "    command: sleep infinity",
        "    networks:",
        "      devnet:",
        "        aliases:",
        `          - ${FIXTURE_ID}-app`,
        "    volumes:",
        `      - ..:${workspaceFolder}:cached`,
        `    working_dir: ${workspaceFolder}`,
        "",
        "networks:",
        "  devnet:",
        "    external: true",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fixture, ".devcontainer/Dockerfile"),
      [
        "FROM node:24.16.0-bookworm-slim",
        "",
        "RUN apt-get update \\",
        "  && apt-get install -y --no-install-recommends ca-certificates curl git procps util-linux \\",
        "  && rm -rf /var/lib/apt/lists/*",
        "",
        `WORKDIR ${workspaceFolder}`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(fixture, ".devcontainer/post-start.sh"), renderAdapter(generation), {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(fixture, "server.js"),
      [
        'const http = require("node:http");',
        "",
        'const index = process.argv.indexOf("--generation");',
        'const generation = index === -1 ? "1" : process.argv[index + 1];',
        "const server = http.createServer((request, response) => {",
        '  response.writeHead(200, { "content-type": "application/json" });',
        "  response.end(",
        "    JSON.stringify({",
        "      ok: true,",
        "      pid: process.pid,",
        "      generation,",
        "      path: request.url,",
        "    }),",
        "  );",
        "});",
        `server.listen(${APP_PORT}, "0.0.0.0");`,
        "",
      ].join("\n"),
    );
  }

  function commitFixture(message: string) {
    requireOk(run("git", ["-C", fixture, "add", "-A"]), "git", ["add"]);
    requireOk(
      run("git", [
        "-C",
        fixture,
        "-c",
        "user.email=preparation@devrouter.local",
        "-c",
        "user.name=devrouter-preparation",
        "commit",
        "-qm",
        message,
      ]),
      "git",
      ["commit"],
    );
  }

  const evidence: string[] = [];
  const cohorts: Record<string, unknown> = {};
  const facts: Record<string, unknown> = {};
  let failure: unknown;
  let teardown: RunResult | undefined;
  let priorRelease: number | undefined;
  let containerId: string | undefined;
  let imageBuildMs: number | undefined;

  try {
    if (fs.existsSync(fixture)) {
      priorRelease = run(node, [dist, "stop", fixture, "--delete", "--json"]).status ?? undefined;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    writeFixture("1");
    requireOk(run("git", ["init", "-q", fixture]), "git", ["init"]);
    commitFixture("process preparation fixture");
    const buildStarted = performance.now();
    requireOk(
      run(
        "docker",
        ["build", "-q", "-t", IMAGE_TAG, "-f", ".devcontainer/Dockerfile", "."],
        fixture,
        600_000,
      ),
      "docker",
      ["build"],
    );
    imageBuildMs = Math.round(performance.now() - buildStarted);

    const cold = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(cold.exitCode, 0, `cold ensure failed: ${cold.stderrTail}`);
    const coldUrls = routeUrls(cold.payload);
    assert.ok(
      coldUrls.some((url) => url.includes(ROUTE_HOST)),
      `cold ensure published no ${ROUTE_HOST} route: ${coldUrls.join(", ")}`,
    );
    const routeUrl = coldUrls.find((url) => url.includes(ROUTE_HOST)) as string;
    containerId = containerIdFor(fixture);
    assert.ok(containerId, "cold ensure left no fixture container");
    const coldFacts = observe(containerId);
    assert.equal(coldFacts.adapter.invocations, 1, "cold ensure must run the adapter once");
    assert.equal(coldFacts.adapter.completions, 1, "cold adapter must complete");
    assert.equal(coldFacts.preparations, 1, "cold ensure must prepare once");
    assert.equal(coldFacts.process.matches, 1, "cold ensure must own exactly one app process");
    assert.ok(coldFacts.process.cmdline.includes("--generation 1"), "cold app generation missing");
    const coldRoute = await waitForRoute(routeUrl, "1");
    assert.ok(coldRoute.ok, `cold route failed: ${JSON.stringify(coldRoute.attempts)}`);
    cohorts.cold = cohort("cold ensure", cold);
    facts.cold = { ...coldFacts, routeProbe: coldRoute };
    evidence.push("cold ensure prepared, launched one owned process and served the route");

    const reuse = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(reuse.exitCode, 0, `unchanged-reuse ensure failed: ${reuse.stderrTail}`);
    assert.equal(containerIdFor(fixture), containerId, "reuse must keep the same container");
    const reuseFacts = observe(containerId);
    assert.equal(reuseFacts.preparations, 1, "unchanged reuse must skip preparation");
    assert.equal(reuseFacts.adapter.invocations, 2, "reuse must replay the adapter");
    assert.equal(reuseFacts.adapter.completions, 2, "reuse adapter must complete");
    assert.equal(reuseFacts.helper?.pid, coldFacts.helper?.pid, "reuse must keep the process");
    assert.equal(reuseFacts.process.matches, 1, "reuse must not duplicate the process");
    const reuseRoute = await waitForRoute(routeUrl, "1");
    assert.ok(reuseRoute.ok, `reuse route failed: ${JSON.stringify(reuseRoute.attempts)}`);
    cohorts.reuse = cohort("unchanged-reuse ensure", reuse);
    facts.reuse = { ...reuseFacts, routeProbe: reuseRoute };
    evidence.push("unchanged reuse kept the owned process and skipped preparation");

    writeFixture("2");
    commitFixture("changed runtime identity");
    const changed = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(changed.exitCode, 0, `runtime-change ensure failed: ${changed.stderrTail}`);
    const changedFacts = observe(containerId);
    assert.equal(changedFacts.preparations, 2, "changed runtime must prepare again");
    assert.notEqual(
      changedFacts.helper?.pid,
      coldFacts.helper?.pid,
      "changed runtime must replace the process",
    );
    assert.equal(changedFacts.process.matches, 1, "changed runtime must own one process");
    assert.ok(
      changedFacts.process.cmdline.includes("--generation 2"),
      "changed app generation missing",
    );
    const changedRoute = await waitForRoute(routeUrl, "2");
    assert.ok(changedRoute.ok, `changed route failed: ${JSON.stringify(changedRoute.attempts)}`);
    cohorts.change = cohort("runtime-change ensure", changed);
    facts.change = { ...changedFacts, routeProbe: changedRoute };
    evidence.push(
      "changed runtime stopped the owned group, prepared again and served generation 2",
    );

    const stop = await runDevrouter(["stop", fixture, "--json"]);
    assert.equal(stop.exitCode, 0, `stop failed: ${stop.stderrTail}`);
    assert.equal(containerState(containerId).status, "exited");
    cohorts.stop = cohort("non-destructive stop", stop);
    const afterStop = journalState();
    assert.equal(afterStop?.desired, "stopped-by-user");
    assert.equal(afterStop?.phase, "idle");
    facts.journalAfterStop = afterStop;
    evidence.push("stop retained the same exited container and recorded idle/stopped-by-user");

    const resume = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(resume.exitCode, 0, `stopped-resume ensure failed: ${resume.stderrTail}`);
    assert.equal(containerIdFor(fixture), containerId, "resume must start the retained container");
    const resumeFacts = observe(containerId);
    assert.equal(resumeFacts.preparations, 3, "resume must prepare again without a live process");
    assert.equal(resumeFacts.process.matches, 1, "resume must own exactly one process");
    const resumeRoute = await waitForRoute(routeUrl, "2");
    assert.ok(resumeRoute.ok, `resume route failed: ${JSON.stringify(resumeRoute.attempts)}`);
    cohorts.resume = cohort("stopped-resume ensure", resume);
    facts.resume = { ...resumeFacts, routeProbe: resumeRoute };
    evidence.push("stopped-resume prepared again and served the retained container's route");

    const resumePid = resumeFacts.helper?.pid;
    execIn(containerId, `rm -f ${HELPER_STATE}`);
    const unowned = await runDevrouter(["ensure", fixture, "--json"]);
    assert.notEqual(unowned.exitCode, 0, "ensure must refuse an unowned app process");
    assert.match(
      unowned.stderrTail,
      /unowned 'app' process/,
      `ensure refusal did not name the unowned process: ${unowned.stderrTail}`,
    );
    const unownedFacts = observe(containerId);
    facts.unowned = { ...unownedFacts };
    const refusalAttempts = unownedFacts.adapter.invocations - resumeFacts.adapter.invocations;
    // The refusal surfaces from the post-start adapter, and the managed rollback
    // replays that adapter once to restore the previous process population. Both
    // attempts refuse, so neither completes, prepares, duplicates or kills.
    assert.ok(refusalAttempts >= 1, "refused ensure must attempt the adapter");
    assert.ok(refusalAttempts <= 2, `refused ensure replayed the adapter ${refusalAttempts} times`);
    assert.equal(
      unownedFacts.adapter.completions,
      resumeFacts.adapter.completions,
      "refused adapter must not complete",
    );
    assert.equal(unownedFacts.preparations, 3, "refused ensure must not prepare");
    assert.equal(unownedFacts.helper, undefined, "refused ensure must not record state");
    // The helper record was removed to create the unowned state, so the
    // surviving process is proven against the identity captured before it.
    const unownedProcess = processFacts(containerId, resumePid);
    assert.equal(unownedProcess.alive, true, "refusal must not kill the process");
    assert.equal(unownedProcess.matches, 1, "refusal must not start a duplicate");
    assert.ok(
      unownedProcess.cmdline.includes("--generation 2"),
      "refusal must keep the original process",
    );
    const unownedRoute = await waitForRoute(routeUrl, "2");
    assert.ok(unownedRoute.ok, `refused ensure must keep the route: ${unownedRoute.attempts}`);
    cohorts.unowned = cohort("unknown-ownership refuse", unowned);
    facts.unowned = { ...unownedFacts, process: unownedProcess, routeProbe: unownedRoute };
    evidence.push(
      `a removed helper record made ensure refuse after ${refusalAttempts} adapter attempts without completing, preparing, killing or duplicating`,
    );

    const recoveryStop = await runDevrouter(["stop", fixture, "--json"]);
    assert.equal(recoveryStop.exitCode, 0, `recovery stop failed: ${recoveryStop.stderrTail}`);
    const recovery = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(recovery.exitCode, 0, `recovery ensure failed: ${recovery.stderrTail}`);
    const recoveryFacts = observe(containerId);
    assert.equal(recoveryFacts.preparations, 4, "recovery must prepare again");
    assert.equal(recoveryFacts.process.matches, 1, "recovery must own exactly one process");
    const recoveryRoute = await waitForRoute(routeUrl, "2");
    assert.ok(recoveryRoute.ok, `recovery route failed: ${JSON.stringify(recoveryRoute.attempts)}`);
    cohorts.recovery = cohort("stop-then-ensure recovery", recovery);
    facts.recovery = { ...recoveryFacts, routeProbe: recoveryRoute };
    evidence.push("stop-then-ensure recovered the refused runtime with a fresh preparation");

    // An external prune can remove the whole workload while the provider
    // registration survives. Stop must prove the exact absent population and
    // settle, instead of leaving the journal in stopping and blocking ensure.
    dockerOut(["rm", "-f", containerId]);
    const pruned = await runDevrouter(["stop", fixture, "--json"]);
    assert.equal(pruned.exitCode, 0, `pruned stop failed: ${pruned.stderrTail}`);
    assert.equal(containerIdFor(fixture), undefined, "pruned stop must not recreate a container");
    const prunedJournal = journalState();
    assert.equal(prunedJournal?.phase, "idle", "pruned stop must settle the journal");
    assert.equal(prunedJournal?.desired, "stopped-by-user");
    assert.equal(routeEntry(), undefined, "pruned stop must free the retained route");
    cohorts.prune = cohort("pruned-population stop", pruned);
    facts.prune = { journal: prunedJournal, route: routeEntry() };
    evidence.push("an externally pruned container population settled stop as proven-absent");
  } catch (error) {
    failure = error;
  } finally {
    try {
      teardown = await runDevrouter(["stop", fixture, "--delete", "--json"]);
      assert.equal(teardown.exitCode, 0, `teardown failed: ${teardown.stderrTail}`);
      assert.equal(containerIdFor(fixture), undefined, "teardown must remove the container");
      assert.equal(routeEntry(), undefined, "teardown must remove the route");
      evidence.push("the final delete removed the exact container and its route");
    } catch (error) {
      failure ??= error;
    }
  }

  const receipt = {
    schemaVersion: 1,
    fixture: { root, checkout: fixture, journalFile, image: IMAGE_TAG, workspaceFolder },
    source: {
      revision: revision.status === 0 ? revision.stdout.trim() : "unknown",
      dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : undefined,
      distSha256: sha256(fs.readFileSync(dist)),
    },
    environment: {
      node: process.version,
      docker: docker.stdout.trim(),
      devsy: devsy.stdout.trim(),
      home: os.homedir(),
      rootCa: caFile,
    },
    priorReleaseExitCode: priorRelease,
    imageBuildMs,
    containerId,
    facts,
    cohorts,
    teardown: teardown ? cohort("teardown", teardown) : undefined,
    evidence,
    failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ evidencePath, ...receipt }, null, 2)}\n`);
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Process-preparation qualification failed.",
  );
  process.exitCode = 1;
});
