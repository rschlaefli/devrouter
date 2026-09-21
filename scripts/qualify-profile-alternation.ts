/**
 * Qualify supported profile changes and host/container alternation.
 *
 * The fixture is a disposable checkout under DR_PROFILE_ROOT whose managed
 * devcontainer declares one profile service and one repository-owned process.
 * Cohorts run on that one workload, in order, so their numbers stay comparable:
 *
 *   lean-cold        ensure --profile lean creates the container with the
 *                    primary service only, prepares once and answers the route
 *   full-warm        ensure --profile full adds the profile service to the
 *                    retained container without replaying environment creation
 *   lean-warm        ensure --profile lean stops the dropped profile service
 *                    after exact ownership proof, without touching the primary
 *   alternation      the exact container mounts the named node_modules volume
 *                    over its node_modules path and still has it mounted in its
 *                    own namespace after the host install, and a host-side
 *                    install and a container-side install stay isolated in both
 *                    directions
 *   unknown-profile  an undefined profile refuses before any mutation
 *   full-again       the retained container takes the profile service back
 *   full-reuse       an unchanged profile keeps the owned process
 *   unrecorded       a container claiming the workspace Compose directory
 *                    outside the retained generation blocks the transition,
 *                    and removing it restores the documented change
 *   stopped-resume   a non-destructive stop retains container and volume, and
 *                    the next ensure starts the same container and prepares again
 *
 * The recorded process identity names the active profile and process set, so
 * every profile change replaces the owned process exactly once while the
 * container, its creation timestamp, its volumes and the install trees stay
 * untouched. That restart is the documented fail-closed rule, not drift, and the
 * unchanged-profile cohort separates it from ordinary ensure churn.
 *
 * Each cohort records wall time, the streamed phase timeline, peak CLI resident
 * memory, the container's memory at readiness and its first-attempt exit code.
 * Container identity, creation timestamp, service population, owned volume set,
 * configured mount table, the running container's own mount namespace,
 * preparation counts and the helper's recorded process identity are read from
 * Docker instead of trusted from devrouter's own report, and the
 * published route is fetched over the machine's real TLS setup as an independent
 * readiness proof.
 * A foreign container that shares the profile service's Compose label but not its
 * project must survive every transition untouched. Nothing is retried: a
 * first-attempt failure is evidence, not noise.
 *
 * The last cohort removes the generated managed profile after the environment
 * exists and requires `stop --delete` to restore that recorded artifact and
 * settle, because the provider resolves the path recorded at registration.
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

const ADAPTER_LOG = "/tmp/devrouter-profile-adapter.log";
const APP_LOG = "/tmp/devrouter-profile-app.log";
const HELPER_STATE = "/tmp/devrouter-process-app.state";
const ROUTE_HOST = "profiles-consumer.localhost";
const APP_PORT = 3000;
const IMAGE_TAG = "devrouter-profile-alternation:local";
const WORKSPACE_FOLDER = "/workspaces/profile-alternation";
const PROFILE_SERVICE = "worker";
const POST_CREATE_COUNT = ".devrouter-post-create-count";
const GENERATED_PROFILE = ".devcontainer/devcontainer.devrouter.json";
const PREPARE_MILLIS = 2000;
const NPM_INSTALL_ARGS = [
  "install",
  "--no-audit",
  "--no-fund",
  "--no-save",
  "--package-lock=false",
];

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
  process.stdout.write(`Profile-alternation qualification skipped: ${reason}\n`);
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

function phaseIndex(result: RunResult, phase: string) {
  return result.events
    .filter((event) => event.kind === "progress")
    .map((event) => event.phase)
    .lastIndexOf(phase);
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
    `  --prepare-command 'sleep ${PREPARE_MILLIS / 1000} && date +%s%N >> ${ADAPTER_LOG}.prepare' \\`,
    `  -- node server.js --generation ${generation}`,
    `printf 'end %s\\n' "$(date +%s%N)" >> ${ADAPTER_LOG}`,
    "",
  ].join("\n");
}

function renderPostCreate() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `count_file="${WORKSPACE_FOLDER}/${POST_CREATE_COUNT}"`,
    "count=0",
    'if [ -f "$count_file" ]; then',
    '  count="$(cat "$count_file")"',
    "fi",
    'printf \'%s\\n\' "$((count + 1))" > "$count_file"',
    "",
  ].join("\n");
}

function renderLocalDependency(name: string, marker: string) {
  return {
    packageJson: `${JSON.stringify(
      { name, version: "1.0.0", private: true, main: "index.js" },
      null,
      2,
    )}\n`,
    indexJs: `module.exports = { marker: ${JSON.stringify(marker)} };\n`,
    markerTxt: `${marker}\n`,
  };
}

async function main() {
  const source = process.cwd();
  const dist = path.resolve(process.env.DR_PROFILE_DIST ?? path.join(source, "dist/devrouter.js"));
  if (!fs.existsSync(dist)) skip("build dist/devrouter.js first (pnpm build).");
  const docker = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (docker.status !== 0) skip("docker is unavailable.");
  const devsy = run("devsy", ["--version"]);
  if (devsy.status !== 0) skip("the devsy provider is unavailable.");
  const hostNpm = run("npm", ["--version"]);
  const node = fs.realpathSync(process.execPath);
  const root = path.join(
    fs.realpathSync(process.env.DR_PROFILE_ROOT ?? os.tmpdir()),
    "devrouter-profile-alternation",
  );
  fs.mkdirSync(root, { recursive: true });
  // The provider derives its workspace id from this folder's basename, so the
  // name must stay unique per qualification fixture; a shared basename makes a
  // run attach and mutate another fixture's container instead of its own.
  const fixture = path.join(root, "profile-alternation-consumer");
  const evidencePath = process.env.DR_PROFILE_EVIDENCE ?? path.join(root, "evidence.json");
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

  function containerCreated(id: string) {
    return dockerOut(["inspect", "-f", "{{.Created}}", id]);
  }

  function containerMemory(id: string) {
    const result = run("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", id]);
    return result.status === 0 ? result.stdout.trim() : "unknown";
  }

  function execIn(id: string, script: string) {
    return requireOk(run("docker", ["exec", id, "sh", "-c", script]), "docker exec", [script]);
  }

  function labelOf(id: string, key: string) {
    return dockerOut(["inspect", "-f", `{{index .Config.Labels "${key}"}}`, id]).trim();
  }

  function composeProjectOf(id: string) {
    return labelOf(id, "com.docker.compose.project");
  }

  function appContainerId(checkout: string) {
    const ids = dockerOut(["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean);
    for (const id of ids) {
      const mounts = run("docker", [
        "inspect",
        "-f",
        "{{range .Mounts}}{{println .Source}}{{end}}",
        id,
      ]);
      if (mounts.status !== 0 || !mounts.stdout.split("\n").includes(checkout)) continue;
      if (labelOf(id, "com.docker.compose.service") === "app") return id;
    }
    return undefined;
  }

  function serviceFacts(project: string, service: string) {
    const ids = dockerOut([
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ])
      .split("\n")
      .filter(Boolean);
    return {
      count: ids.length,
      ids,
      running: ids.some((id) => containerState(id).status === "running"),
    };
  }

  function volumeNames(project: string) {
    return dockerOut([
      "volume",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Name}}",
    ])
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  function containerMounts(id: string) {
    const raw = dockerOut(["inspect", "-f", "{{json .Mounts}}", id]);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`docker inspect returned no mount table for ${id}`);
    return parsed.map((entry) => {
      const record = asRecord(entry);
      return {
        type: text(record?.Type) ?? "unknown",
        name: text(record?.Name) ?? null,
        source: text(record?.Source) ?? null,
        destination: text(record?.Destination) ?? null,
      };
    });
  }

  // The isolation cell only means something if the exact container really
  // mounts the named volume over its node_modules path. A missing or replaced
  // mount writes the container install straight into the fixture checkout, so
  // the assertion reports the observed mount table instead of a bare boolean.
  function assertWorkspaceIsolation(id: string, project: string) {
    const mounts = containerMounts(id);
    const detail = JSON.stringify(mounts);
    const workspace = mounts.find((mount) => mount.destination === WORKSPACE_FOLDER);
    const nodeModules = mounts.find(
      (mount) => mount.destination === `${WORKSPACE_FOLDER}/node_modules`,
    );
    const workspaceSource = workspace?.source ?? "";
    assert.ok(
      workspace?.type === "bind" &&
        workspaceSource.length > 0 &&
        fs.existsSync(workspaceSource) &&
        fs.realpathSync(workspaceSource) === fs.realpathSync(fixture),
      `container ${id} does not bind-mount the fixture at ${WORKSPACE_FOLDER}: ${detail}`,
    );
    assert.equal(
      nodeModules?.type,
      "volume",
      `container ${id} does not mount ${WORKSPACE_FOLDER}/node_modules as a volume: ${detail}`,
    );
    assert.equal(
      nodeModules?.name,
      `${project}_node_modules`,
      `container ${id} mounts an unexpected node_modules volume: ${detail}`,
    );
    return mounts;
  }

  // A container's configured mounts and the mounts its namespace actually has
  // are different things: a nested volume can be unwound while the container
  // keeps running, and the path underneath (the host bind mount) then absorbs
  // every container-side write. Only the container's own namespace shows that.
  function effectiveWorkspaceMounts(id: string) {
    return execIn(id, "cat /proc/self/mountinfo")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "))
      .filter((fields) => fields[4]?.startsWith(WORKSPACE_FOLDER))
      .map((fields) => {
        const separator = fields.indexOf("-");
        return {
          destination: fields[4],
          type: separator >= 0 ? fields[separator + 1] : "unknown",
          source: separator >= 0 ? fields[separator + 2] : "unknown",
        };
      });
  }

  function assertVolumeStillEffective(id: string, context: string) {
    const mounts = effectiveWorkspaceMounts(id);
    const nodeModules = mounts.find(
      (mount) => mount.destination === `${WORKSPACE_FOLDER}/node_modules`,
    );
    assert.ok(
      nodeModules && nodeModules.type !== "virtiofs",
      `${context}: the named node_modules volume is no longer mounted in container ${id} ` +
        `(effective workspace mounts ${JSON.stringify(mounts)}); the host bind mount underneath ` +
        "absorbs container-side writes. Restart the exact container to re-apply its mounts.",
    );
    return mounts;
  }

  function preparationRuns(id: string) {
    return execIn(id, `cat ${ADAPTER_LOG}.prepare 2>/dev/null || true`)
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

  function containerPathState(id: string, target: string) {
    return execIn(
      id,
      `if [ -e ${target} ]; then echo present; elif [ -L ${target} ]; then echo link; else echo absent; fi`,
    ).trim();
  }

  function containerFile(id: string, file: string) {
    const value = execIn(id, `cat ${file} 2>/dev/null || true`).trim();
    return value.length > 0 ? value : undefined;
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

  function postCreateCount() {
    const file = path.join(fixture, POST_CREATE_COUNT);
    if (!fs.existsSync(file)) return null;
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const value = Number(lines[lines.length - 1]);
    return Number.isFinite(value) ? value : null;
  }

  function hostDependencyPath(name: string) {
    return path.join(fixture, "node_modules", name);
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

  function observe(id: string, project: string) {
    const helper = helperRecord(id);
    return {
      container: containerState(id),
      created: containerCreated(id),
      memory: containerMemory(id),
      services: { [PROFILE_SERVICE]: serviceFacts(project, PROFILE_SERVICE) },
      volumes: volumeNames(project),
      mounts: containerMounts(id),
      adapter: adapterStats(id),
      preparations: preparationRuns(id),
      helper,
      process: processFacts(id, helper?.pid),
      journal: journalState(),
      route: routeEntry(),
      postCreateCount: postCreateCount(),
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

  function writeFixture() {
    fs.mkdirSync(path.join(fixture, ".devcontainer"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, ".gitignore"),
      [
        GENERATED_PROFILE,
        ".devcontainer/docker-compose.devrouter-network.yml",
        "node_modules/",
        POST_CREATE_COUNT,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fixture, ".devrouter.yml"),
      [
        "version: 1",
        "project:",
        "  name: profile-alternation",
        "managedRuntime:",
        "  devcontainer:",
        "    baseServices: []",
        `    profileServices: [${PROFILE_SERVICE}]`,
        "  processes: [app]",
        "profiles:",
        "  full:",
        "    apps: ['*']",
        "    processes: ['*']",
        `    devcontainerServices: [${PROFILE_SERVICE}]`,
        "    default: true",
        "  lean:",
        "    apps: ['*']",
        "    processes: [app]",
        "    devcontainerServices: []",
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
      path.join(fixture, "package.json"),
      `${JSON.stringify({ name: "profile-alternation", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(fixture, ".devcontainer/devcontainer.json"),
      `${JSON.stringify(
        {
          name: "devrouter-profile-alternation",
          dockerComposeFile: "docker-compose.yml",
          service: "app",
          workspaceFolder: WORKSPACE_FOLDER,
          postCreateCommand: "bash .devcontainer/post-create.sh",
          waitFor: "postCreateCommand",
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
        "          - profile-alternation-app",
        "    volumes:",
        `      - ..:${WORKSPACE_FOLDER}:cached`,
        `      - node_modules:${WORKSPACE_FOLDER}/node_modules`,
        `    working_dir: ${WORKSPACE_FOLDER}`,
        `  ${PROFILE_SERVICE}:`,
        `    image: ${IMAGE_TAG}`,
        "    init: true",
        "    command: sleep infinity",
        "    networks:",
        "      devnet:",
        "        aliases:",
        `          - profile-alternation-${PROFILE_SERVICE}`,
        "",
        "networks:",
        "  devnet:",
        "    external: true",
        "",
        "volumes:",
        "  node_modules:",
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
        `WORKDIR ${WORKSPACE_FOLDER}`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(fixture, ".devcontainer/post-start.sh"), renderAdapter("1"), {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(fixture, ".devcontainer/post-create.sh"), renderPostCreate(), {
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
    for (const [name, marker] of [
      ["host-dep", "host"],
      ["container-dep", "container"],
    ] as const) {
      const directory = path.join(fixture, `local-${name}`);
      fs.mkdirSync(directory, { recursive: true });
      const files = renderLocalDependency(name, marker);
      fs.writeFileSync(path.join(directory, "package.json"), files.packageJson);
      fs.writeFileSync(path.join(directory, "index.js"), files.indexJs);
      fs.writeFileSync(path.join(directory, "marker.txt"), files.markerTxt);
    }
  }

  function commitFixture(message: string) {
    requireOk(run("git", ["-C", fixture, "add", "-A"]), "git", ["add"]);
    requireOk(
      run("git", [
        "-C",
        fixture,
        "-c",
        "user.email=profiles@devrouter.local",
        "-c",
        "user.name=devrouter-profiles",
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
  const strayContainers: string[] = [];
  let failure: unknown;
  let teardown: RunResult | undefined;
  let priorRelease: number | undefined;
  let containerId: string | undefined;
  let composeProject: string | undefined;
  let imageBuildMs: number | undefined;

  try {
    if (fs.existsSync(fixture)) {
      // A previous fixture is only replaced after its release is proven, so a
      // stuck environment is reported instead of being orphaned by a rebuild.
      const release = await runDevrouter(["stop", fixture, "--delete", "--json"]);
      priorRelease = release.exitCode ?? undefined;
      assert.equal(
        release.exitCode,
        0,
        `a previous fixture could not be released: ${release.stderrTail}`,
      );
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    writeFixture();
    requireOk(run("git", ["init", "-q", fixture]), "git", ["init"]);
    commitFixture("profile alternation fixture");
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

    // Lean first, so the profile service has to arrive on a warm container.
    const leanCold = await runDevrouter(["ensure", fixture, "--profile", "lean", "--json"]);
    assert.equal(leanCold.exitCode, 0, `lean-cold ensure failed: ${leanCold.stderrTail}`);
    const leanColdUrls = routeUrls(leanCold.payload);
    const routeUrl = leanColdUrls.find((url) => url.includes(ROUTE_HOST));
    assert.ok(
      routeUrl,
      `lean-cold ensure published no ${ROUTE_HOST} route: ${leanColdUrls.join(", ")}`,
    );
    containerId = appContainerId(fixture);
    assert.ok(containerId, "lean-cold ensure left no fixture app container");
    composeProject = composeProjectOf(containerId);
    const created = containerCreated(containerId);
    const leanFacts = observe(containerId, composeProject);
    assert.equal(
      leanFacts.services[PROFILE_SERVICE].count,
      0,
      "the lean profile must not create the profile service",
    );
    assert.equal(leanFacts.adapter.invocations, 1, "lean-cold ensure must run the adapter once");
    assert.equal(leanFacts.adapter.completions, 1, "lean-cold adapter must complete");
    assert.equal(leanFacts.preparations, 1, "lean-cold ensure must prepare once");
    assert.equal(leanFacts.process.matches, 1, "lean-cold ensure must own exactly one app process");
    if (leanFacts.postCreateCount !== null) assert.equal(leanFacts.postCreateCount, 1);
    const leanRoute = await waitForRoute(routeUrl, "1");
    assert.ok(leanRoute.ok, `lean-cold route failed: ${JSON.stringify(leanRoute.attempts)}`);
    cohorts["lean-cold"] = cohort("lean-cold ensure", leanCold);
    facts["lean-cold"] = { ...leanFacts, routeProbe: leanRoute };
    evidence.push(
      `the lean profile created the environment with ${leanFacts.volumes.length} owned volume(s) and no profile service`,
    );

    const fullWarm = await runDevrouter(["ensure", fixture, "--profile", "full", "--json"]);
    const fullFacts = observe(containerId, composeProject);
    facts["full-warm"] = { ...fullFacts };
    assert.equal(fullWarm.exitCode, 0, `full-warm ensure failed: ${fullWarm.stderrTail}`);
    assert.equal(
      appContainerId(fixture),
      containerId,
      "the full profile must keep the primary app container",
    );
    assert.equal(containerCreated(containerId), created);
    assert.equal(
      fullFacts.services[PROFILE_SERVICE].count,
      1,
      "the full profile must run exactly one profile service container",
    );
    assert.equal(fullFacts.services[PROFILE_SERVICE].running, true);
    assert.deepEqual(fullFacts.volumes, leanFacts.volumes);
    // The recorded process identity names the active profile and process set, so
    // a profile change stops the owned group exactly once and prepares again
    // instead of adopting a process whose identity no longer matches.
    assert.equal(fullFacts.preparations, 2, "a profile change must replace the owned process");
    assert.notEqual(fullFacts.helper?.pid, leanFacts.helper?.pid);
    assert.notEqual(fullFacts.helper?.fingerprint, leanFacts.helper?.fingerprint);
    assert.equal(fullFacts.process.matches, 1);
    if (fullFacts.postCreateCount !== null) assert.equal(fullFacts.postCreateCount, 1);
    assert.ok(phaseIndex(fullWarm, "service-start") < phaseIndex(fullWarm, "route-publication"));
    const fullRoute = await waitForRoute(routeUrl, "1");
    assert.ok(fullRoute.ok, `full-warm route failed: ${JSON.stringify(fullRoute.attempts)}`);
    assert.equal(fullFacts.journal?.phase, "stable");
    assert.equal(fullFacts.journal?.desired, "running");
    cohorts["full-warm"] = cohort("full-warm ensure", fullWarm);
    facts["full-warm"] = { ...fullFacts, routeProbe: fullRoute };
    evidence.push(
      "the full profile added its service to the retained container, re-established the owned process identity once and republished the route last",
    );

    // A foreign container that carries the profile service's Compose label but
    // belongs to another project and workspace must survive the drop untouched.
    const decoy = dockerOut([
      "run",
      "-d",
      "--label",
      "com.docker.compose.project=profile-alternation-foreign",
      "--label",
      `com.docker.compose.service=${PROFILE_SERVICE}`,
      "--label",
      "com.docker.compose.project.working_dir=/tmp/profile-alternation-foreign/.devcontainer",
      IMAGE_TAG,
      "sleep",
      "infinity",
    ]);
    strayContainers.push(decoy);
    const workerId = fullFacts.services[PROFILE_SERVICE].ids[0];
    const leanWarm = await runDevrouter(["ensure", fixture, "--profile", "lean", "--json"]);
    const leanWarmFacts = observe(containerId, composeProject);
    facts["lean-warm"] = { ...leanWarmFacts, decoy };
    assert.equal(leanWarm.exitCode, 0, `lean-warm ensure failed: ${leanWarm.stderrTail}`);
    assert.equal(appContainerId(fixture), containerId);
    assert.equal(containerCreated(containerId), created);
    assert.equal(leanWarmFacts.services[PROFILE_SERVICE].running, false);
    assert.ok(leanWarmFacts.services[PROFILE_SERVICE].count <= 1);
    assert.ok(
      leanWarmFacts.services[PROFILE_SERVICE].ids.every((id) => id === workerId),
      "the lean profile must stop the exact retained profile service container",
    );
    assert.equal(leanWarmFacts.services[PROFILE_SERVICE].ids.includes(decoy), false);
    assert.equal(
      containerState(decoy).status,
      "running",
      "a foreign service container must survive",
    );
    dockerOut(["rm", "-f", decoy]);
    strayContainers.pop();
    assert.deepEqual(leanWarmFacts.volumes, leanFacts.volumes);
    assert.equal(leanWarmFacts.preparations, 3, "each profile change must prepare once");
    assert.notEqual(leanWarmFacts.helper?.pid, fullFacts.helper?.pid);
    assert.notEqual(leanWarmFacts.helper?.fingerprint, fullFacts.helper?.fingerprint);
    assert.equal(leanWarmFacts.process.matches, 1);
    assert.ok(phaseIndex(leanWarm, "service-stop") < phaseIndex(leanWarm, "route-publication"));
    const leanWarmRoute = await waitForRoute(routeUrl, "1");
    assert.ok(
      leanWarmRoute.ok,
      `lean-warm route failed: ${JSON.stringify(leanWarmRoute.attempts)}`,
    );
    cohorts["lean-warm"] = cohort("lean-warm ensure", leanWarm);
    facts["lean-warm"] = { ...leanWarmFacts, routeProbe: leanWarmRoute, decoy };
    evidence.push(
      "the lean profile stopped its exact retained service, left the primary container and a foreign service container untouched, and republished the route last",
    );

    // Host/container alternation: the named node_modules volume must keep the
    // two install trees separate in both directions.
    const alternationMounts = assertWorkspaceIsolation(containerId, composeProject);
    assertVolumeStillEffective(containerId, "before the host install");
    const hostInstall = run("npm", [...NPM_INSTALL_ARGS, "./local-host-dep"], fixture, 300_000);
    requireOk(hostInstall, "npm", ["install"]);
    const hostMarker = fs
      .readFileSync(path.join(hostDependencyPath("host-dep"), "marker.txt"), "utf8")
      .trim();
    assert.equal(hostMarker, "host");
    // A host-side install rewrites the checkout's node_modules directory. That
    // is exactly the moment a nested volume mount can disappear on this
    // machine's file sharing, so read the namespace again before trusting the
    // container-side install to land in the volume.
    const mountsAfterHostInstall = assertVolumeStillEffective(
      containerId,
      "after the host install",
    );
    const containerInstall = await runDevrouter([
      "exec",
      fixture,
      "--",
      "bash",
      "-lc",
      `cd ${WORKSPACE_FOLDER} && npm ${NPM_INSTALL_ARGS.join(" ")} ./local-container-dep`,
    ]);
    assert.equal(
      containerInstall.exitCode,
      0,
      `container install failed: ${containerInstall.stderrTail}`,
    );
    const containerMarker = containerFile(
      containerId,
      `${WORKSPACE_FOLDER}/node_modules/container-dep/marker.txt`,
    );
    assert.equal(containerMarker, "container");
    const containerSeesHostDep = containerPathState(
      containerId,
      `${WORKSPACE_FOLDER}/node_modules/host-dep`,
    );
    assert.equal(containerSeesHostDep, "absent");
    assert.equal(
      fs.existsSync(hostDependencyPath("container-dep")),
      false,
      `the container install reached the fixture checkout; container ${containerId} configured ${JSON.stringify(alternationMounts)} and its namespace held ${JSON.stringify(mountsAfterHostInstall)}`,
    );
    cohorts["alternation-exec"] = cohort("container-side install", containerInstall);
    facts.alternation = {
      hostNpm: hostNpm.status === 0 ? hostNpm.stdout.trim() : "unknown",
      containerNode: execIn(containerId, "node -v"),
      containerMarker,
      containerSeesHostDep,
      hostMarker,
      hostSeesContainerDep: false,
      mounts: alternationMounts,
      effectiveMountsAfterHostInstall: mountsAfterHostInstall,
    };
    evidence.push(
      "a host install and a container install stayed isolated by the named node_modules volume in both directions",
    );

    const unknown = await runDevrouter([
      "ensure",
      fixture,
      "--profile",
      "does-not-exist",
      "--json",
    ]);
    const unknownFacts = observe(containerId, composeProject);
    facts["unknown-profile"] = { ...unknownFacts };
    assert.notEqual(unknown.exitCode, 0, "ensure must refuse an undefined profile");
    assert.match(unknown.stderrTail, /not defined in \.devrouter\.yml/);
    assert.equal(appContainerId(fixture), containerId);
    assert.equal(unknownFacts.services[PROFILE_SERVICE].running, false);
    assert.equal(unknownFacts.preparations, 3);
    assert.equal(unknownFacts.helper?.pid, leanWarmFacts.helper?.pid);
    assert.equal(unknownFacts.process.matches, 1);
    assert.equal(
      containerFile(containerId, `${WORKSPACE_FOLDER}/node_modules/container-dep/marker.txt`),
      "container",
    );
    const unknownRoute = await waitForRoute(routeUrl, "1");
    assert.ok(unknownRoute.ok, `refused ensure must keep the route: ${unknownRoute.attempts}`);
    cohorts["unknown-profile"] = cohort("undefined-profile refusal", unknown);
    facts["unknown-profile"] = { ...unknownFacts, routeProbe: unknownRoute };
    evidence.push("an undefined profile refused before any mutation and left the runtime serving");

    const fullAgain = await runDevrouter(["ensure", fixture, "--profile", "full", "--json"]);
    const fullAgainFacts = observe(containerId, composeProject);
    facts["full-again"] = { ...fullAgainFacts };
    assert.equal(fullAgain.exitCode, 0, `full-again ensure failed: ${fullAgain.stderrTail}`);
    assert.equal(appContainerId(fixture), containerId);
    assert.equal(containerCreated(containerId), created);
    assert.equal(fullAgainFacts.services[PROFILE_SERVICE].running, true);
    assert.equal(fullAgainFacts.preparations, 4);
    assert.equal(fullAgainFacts.process.matches, 1);
    assert.equal(
      containerFile(containerId, `${WORKSPACE_FOLDER}/node_modules/container-dep/marker.txt`),
      "container",
      "a profile change must not disturb the container install tree",
    );
    assert.deepEqual(fullAgainFacts.volumes, leanFacts.volumes);
    const fullAgainRoute = await waitForRoute(routeUrl, "1");
    assert.ok(
      fullAgainRoute.ok,
      `full-again route failed: ${JSON.stringify(fullAgainRoute.attempts)}`,
    );
    cohorts["full-again"] = cohort("full-again ensure", fullAgain);
    facts["full-again"] = { ...fullAgainFacts, routeProbe: fullAgainRoute };
    evidence.push(
      "the retained container took its profile service back with the install tree intact",
    );

    // An unchanged profile must reuse the owned process instead of preparing
    // again, which separates the profile change from every ordinary ensure.
    const fullReuse = await runDevrouter(["ensure", fixture, "--profile", "full", "--json"]);
    const fullReuseFacts = observe(containerId, composeProject);
    facts["full-reuse"] = { ...fullReuseFacts };
    assert.equal(fullReuse.exitCode, 0, `full-reuse ensure failed: ${fullReuse.stderrTail}`);
    assert.equal(appContainerId(fixture), containerId);
    assert.equal(fullReuseFacts.preparations, 4, "an unchanged profile must reuse the process");
    assert.equal(fullReuseFacts.helper?.pid, fullAgainFacts.helper?.pid);
    assert.equal(fullReuseFacts.helper?.fingerprint, fullAgainFacts.helper?.fingerprint);
    assert.equal(fullReuseFacts.process.matches, 1);
    const fullReuseRoute = await waitForRoute(routeUrl, "1");
    assert.ok(
      fullReuseRoute.ok,
      `full-reuse route failed: ${JSON.stringify(fullReuseRoute.attempts)}`,
    );
    cohorts["full-reuse"] = cohort("full-reuse ensure", fullReuse);
    facts["full-reuse"] = { ...fullReuseFacts, routeProbe: fullReuseRoute };
    evidence.push("an unchanged profile kept the owned process and skipped preparation");

    // A container that claims this workspace's Compose directory without being
    // part of the retained generation must block the transition instead of
    // being adopted, stopped or ignored.
    const unrecorded = dockerOut([
      "run",
      "-d",
      "--label",
      "com.docker.compose.project=profile-alternation-unrecorded",
      "--label",
      `com.docker.compose.service=${PROFILE_SERVICE}`,
      "--label",
      `com.docker.compose.project.working_dir=${fixture}/.devcontainer`,
      IMAGE_TAG,
      "sleep",
      "infinity",
    ]);
    strayContainers.push(unrecorded);
    const unrecordedRefusal = await runDevrouter([
      "ensure",
      fixture,
      "--profile",
      "lean",
      "--json",
    ]);
    const unrecordedFacts = observe(containerId, composeProject);
    facts["unrecorded-population"] = { ...unrecordedFacts, stray: unrecorded };
    assert.notEqual(
      unrecordedRefusal.exitCode,
      0,
      "an unrecorded container must block the transition",
    );
    assert.match(unrecordedRefusal.stderrTail, /unrecorded container population/);
    assert.equal(appContainerId(fixture), containerId);
    assert.equal(containerState(containerId).status, "running");
    assert.equal(unrecordedFacts.services[PROFILE_SERVICE].running, true);
    assert.equal(unrecordedFacts.preparations, 4);
    assert.equal(unrecordedFacts.helper?.pid, fullReuseFacts.helper?.pid);
    assert.equal(containerState(unrecorded).status, "running");
    const unrecordedRoute = await waitForRoute(routeUrl, "1");
    assert.ok(
      unrecordedRoute.ok,
      `unrecorded-container refusal must keep the route: ${JSON.stringify(unrecordedRoute.attempts)}`,
    );
    cohorts["unrecorded-population"] = cohort("unrecorded-population refusal", unrecordedRefusal);
    facts["unrecorded-population"] = {
      ...unrecordedFacts,
      stray: unrecorded,
      routeProbe: unrecordedRoute,
    };
    dockerOut(["rm", "-f", unrecorded]);
    strayContainers.pop();
    evidence.push(
      "a container claiming the workspace Compose directory outside the retained generation blocked the transition while the runtime kept serving",
    );

    const unrecordedRecovery = await runDevrouter([
      "ensure",
      fixture,
      "--profile",
      "lean",
      "--json",
    ]);
    const unrecordedRecoveryFacts = observe(containerId, composeProject);
    facts["unrecorded-recovery"] = { ...unrecordedRecoveryFacts };
    assert.equal(
      unrecordedRecovery.exitCode,
      0,
      `recovery after removing the stray container failed: ${unrecordedRecovery.stderrTail}`,
    );
    assert.equal(unrecordedRecoveryFacts.services[PROFILE_SERVICE].running, false);
    assert.equal(unrecordedRecoveryFacts.preparations, 5);
    const unrecordedRecoveryRoute = await waitForRoute(routeUrl, "1");
    assert.ok(
      unrecordedRecoveryRoute.ok,
      `post-refusal recovery route failed: ${JSON.stringify(unrecordedRecoveryRoute.attempts)}`,
    );
    cohorts["unrecorded-recovery"] = cohort("post-refusal recovery", unrecordedRecovery);
    facts["unrecorded-recovery"] = {
      ...unrecordedRecoveryFacts,
      routeProbe: unrecordedRecoveryRoute,
    };
    evidence.push("removing the stray container restored the documented profile transition");

    const stop = await runDevrouter(["stop", fixture, "--json"]);
    assert.equal(stop.exitCode, 0, `stop failed: ${stop.stderrTail}`);
    assert.equal(containerState(containerId).status, "exited");
    assert.equal(routeEntry(), undefined);
    cohorts.stop = cohort("non-destructive stop", stop);
    const afterStop = journalState();
    assert.equal(afterStop?.desired, "stopped-by-user");
    assert.equal(afterStop?.phase, "idle");
    facts.journalAfterStop = afterStop;

    const resume = await runDevrouter(["ensure", fixture, "--profile", "full", "--json"]);
    const resumeFacts = observe(containerId, composeProject);
    facts.resume = { ...resumeFacts };
    assert.equal(resume.exitCode, 0, `stopped-resume ensure failed: ${resume.stderrTail}`);
    assert.equal(appContainerId(fixture), containerId, "resume must start the retained container");
    assert.equal(containerCreated(containerId), created);
    assert.equal(resumeFacts.services[PROFILE_SERVICE].running, true);
    assert.equal(resumeFacts.preparations, 6, "resume must prepare again without a live process");
    assert.notEqual(resumeFacts.helper?.pid, unrecordedRecoveryFacts.helper?.pid);
    assert.equal(resumeFacts.process.matches, 1);
    assert.equal(
      containerFile(containerId, `${WORKSPACE_FOLDER}/node_modules/container-dep/marker.txt`),
      "container",
      "the named volume must survive a stop and resume",
    );
    assert.ok(fs.existsSync(path.join(hostDependencyPath("host-dep"), "marker.txt")));
    const resumeRoute = await waitForRoute(routeUrl, "1");
    assert.ok(resumeRoute.ok, `resume route failed: ${JSON.stringify(resumeRoute.attempts)}`);
    cohorts.resume = cohort("stopped-resume ensure", resume);
    facts.resume = { ...resumeFacts, routeProbe: resumeRoute };
    evidence.push(
      "a non-destructive stop retained the container and both install trees, and the resume prepared the process again",
    );

    // Removing the generated profile after the environment exists must not
    // strand the checkout: Devsy resolves the config by the recorded path, so
    // stop --delete has to restore the exact recorded artifact first.
    const generatedProfile = path.join(fixture, GENERATED_PROFILE);
    fs.rmSync(generatedProfile);
    assert.equal(fs.existsSync(generatedProfile), false, "the fixture lost its generated profile");
    const restored = await runDevrouter(["stop", fixture, "--delete", "--json"]);
    assert.equal(restored.exitCode, 0, `stop --delete failed: ${restored.stderrTail}`);
    assert.equal(appContainerId(fixture), undefined, "the delete must remove the exact container");
    assert.equal(routeEntry(), undefined, "the delete must remove the route");
    assert.ok(
      fs.existsSync(generatedProfile),
      "the delete must restore the recorded generated profile",
    );
    const restoredJournal = journalState();
    assert.equal(restoredJournal?.phase, "idle");
    assert.equal(restoredJournal?.desired, "stopped-by-user");
    cohorts["generated-profile-restore"] = cohort("missing generated profile", restored);
    facts["generated-profile-restore"] = { journal: restoredJournal };
    evidence.push(
      "a generated profile removed after the environment existed was restored before the provider delete, and the stop settled its journal",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      for (const stray of strayContainers) dockerOut(["rm", "-f", stray]);
      teardown = await runDevrouter(["stop", fixture, "--delete", "--json"]);
      assert.equal(teardown.exitCode, 0, `teardown failed: ${teardown.stderrTail}`);
      assert.equal(appContainerId(fixture), undefined, "teardown must remove the container");
      assert.equal(routeEntry(), undefined, "teardown must remove the route");
      assert.ok(
        fs.existsSync(path.join(hostDependencyPath("host-dep"), "marker.txt")),
        "teardown must not delete host dependencies",
      );
      evidence.push(
        "the final delete removed the exact container and its route, and left host files alone",
      );
    } catch (error) {
      failure ??= error;
    }
  }

  const receipt = {
    schemaVersion: 1,
    fixture: {
      root,
      checkout: fixture,
      journalFile,
      image: IMAGE_TAG,
      workspaceFolder: WORKSPACE_FOLDER,
      profileService: PROFILE_SERVICE,
    },
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
    composeProject,
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
    error instanceof Error ? error.message : "Profile-alternation qualification failed.",
  );
  process.exitCode = 1;
});
