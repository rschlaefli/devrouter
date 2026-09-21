/**
 * Qualify the stopped-resume and fault-recovery cohorts of one managed checkout.
 *
 * The fixture is a disposable checkout under DR_COHORT_ROOT whose devcontainer is
 * a one-service Compose file, so devrouter manages it through the machine's real
 * provider and reliability journal. Three cohorts run on that one workload, in
 * order, so their numbers stay comparable:
 *
 *   cold             a first ensure creates the container and runs the adapter
 *   stopped-resume   a non-destructive stop retains the container and its data;
 *                    the next ensure starts the same retained container again
 *   fault-recovery   a SIGKILL leaves the journal healthy while the container is
 *                    dead; the next ensure recovers the same container
 *
 * Assertions stay inside documented contracts: the fixture declares no routed app,
 * so route publication is observed as a lifecycle phase rather than proven as a
 * route. Each cohort records its wall time, streamed phase timeline, the peak
 * resident memory of the CLI process, the container's memory at readiness and its
 * first-attempt exit code. Container identity, retained data and the adapter
 * invocation count are read from Docker instead of trusted from devrouter's own
 * report. Nothing is retried: a first-attempt failure is evidence, not noise.
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

const ADAPTER_LOG = "/tmp/devrouter-cohort-adapter.log";
const MARKER = "/tmp/devrouter-cohort-marker";

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

function run(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
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
  process.stdout.write(`Lifecycle-cohort qualification skipped: ${reason}\n`);
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

async function main() {
  const source = process.cwd();
  const dist = path.resolve(process.env.DR_COHORT_DIST ?? path.join(source, "dist/devrouter.js"));
  if (!fs.existsSync(dist)) skip("build dist/devrouter.js first (pnpm build).");
  const docker = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (docker.status !== 0) skip("docker is unavailable.");
  const devsy = run("devsy", ["--version"]);
  if (devsy.status !== 0) skip("the devsy provider is unavailable.");
  const node = fs.realpathSync(process.execPath);
  const root = path.join(
    fs.realpathSync(process.env.DR_COHORT_ROOT ?? os.tmpdir()),
    "devrouter-lifecycle-cohorts",
  );
  fs.mkdirSync(root, { recursive: true });
  // The provider derives its workspace id from this folder's basename, so the
  // name must stay unique per qualification fixture; a shared basename makes a
  // run attach and mutate another fixture's container instead of its own.
  const fixture = path.join(root, "cohorts-consumer");
  const image = process.env.DR_COHORT_IMAGE ?? "mcr.microsoft.com/devcontainers/base:debian";
  const evidencePath = process.env.DR_COHORT_EVIDENCE ?? path.join(root, "evidence.json");
  const journalFile = path.join(
    os.homedir(),
    ".config",
    "devrouter",
    "reliability",
    `${sha256(fixture)}.json`,
  );
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

  function adapterRuns(id: string) {
    return Number(execIn(id, `wc -l < ${ADAPTER_LOG}`).trim());
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
          stderrTail: stderrLines.slice(-3).join("\n"),
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

  function prepareFixture() {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.mkdirSync(path.join(fixture, ".devcontainer"), { recursive: true });
    fs.writeFileSync(path.join(fixture, ".devrouter.yml"), "version: 1\napps: []\n");
    fs.writeFileSync(
      path.join(fixture, ".devcontainer/devcontainer.json"),
      `${JSON.stringify(
        {
          name: "devrouter-lifecycle-cohorts",
          dockerComposeFile: "docker-compose.yml",
          service: "app",
          workspaceFolder: "/workspaces/devrouter-lifecycle-cohorts",
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
        `    image: ${image}`,
        "    init: true",
        "    command: sleep infinity",
        "    volumes:",
        "      - ..:/workspaces/devrouter-lifecycle-cohorts:cached",
        "    working_dir: /workspaces/devrouter-lifecycle-cohorts",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fixture, ".devcontainer/post-start.sh"),
      [
        "#!/usr/bin/env bash",
        "# devrouter:managed devcontainer",
        "set -euo pipefail",
        "",
        ': "${DEVROUTER_PROCESS_HELPER:?Run devrouter ensure to start this managed application process.}"',
        `echo started >> ${ADAPTER_LOG}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    requireOk(run("git", ["init", "-q", fixture]), "git", ["init"]);
    requireOk(run("git", ["-C", fixture, "add", "-A"]), "git", ["add"]);
    requireOk(
      run("git", [
        "-C",
        fixture,
        "-c",
        "user.email=cohorts@devrouter.local",
        "-c",
        "user.name=devrouter-cohorts",
        "commit",
        "-qm",
        "lifecycle cohort fixture",
      ]),
      "git",
      ["commit"],
    );
  }

  const evidence: string[] = [];
  const cohorts: Record<string, unknown> = {};
  const containerFacts: Record<string, unknown> = {};
  let failure: unknown;
  let teardown: RunResult | undefined;
  let priorRelease: number | undefined;
  let containerId: string | undefined;

  try {
    if (fs.existsSync(fixture)) {
      priorRelease = run(node, [dist, "stop", fixture, "--delete", "--json"]).status ?? undefined;
    }
    prepareFixture();

    const cold = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(cold.exitCode, 0, `cold ensure failed: ${cold.stderrTail}`);
    containerId = containerIdFor(fixture);
    assert.ok(containerId, "cold ensure left no fixture container");
    assert.equal(containerState(containerId).status, "running");
    assert.equal(adapterRuns(containerId), 1, "cold ensure must run the adapter once");
    cohorts.cold = cohort("cold ensure", cold);
    containerFacts.coldMemory = containerMemory(containerId);
    execIn(containerId, `echo ${Date.now()} > ${MARKER}`);
    evidence.push("cold ensure created one managed container and ran the adapter once");

    const stop = await runDevrouter(["stop", fixture, "--json"]);
    assert.equal(stop.exitCode, 0, `stop failed: ${stop.stderrTail}`);
    assert.equal(containerState(containerId).status, "exited");
    const afterStop = journalState();
    assert.equal(afterStop?.desired, "stopped-by-user");
    assert.equal(afterStop?.phase, "idle");
    cohorts.stop = cohort("non-destructive stop", stop);
    containerFacts.journalAfterStop = afterStop;
    evidence.push("stop retained the same container exited and recorded idle/stopped-by-user");

    const resume = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(resume.exitCode, 0, `stopped-resume ensure failed: ${resume.stderrTail}`);
    assert.equal(containerIdFor(fixture), containerId, "resume must start the retained container");
    assert.equal(containerState(containerId).status, "running");
    assert.equal(adapterRuns(containerId), 2, "resume must run the adapter again");
    assert.ok(execIn(containerId, `cat ${MARKER}`).length > 0, "retained marker missing");
    cohorts.resume = cohort("stopped-resume ensure", resume);
    containerFacts.resumeMemory = containerMemory(containerId);
    containerFacts.journalAfterResume = journalState();
    evidence.push("stopped-resume started the same retained container with data intact");

    requireOk(run("docker", ["kill", containerId]), "docker", ["kill"]);
    const killed = containerState(containerId);
    assert.equal(killed.status, "exited");
    assert.equal(killed.exitCode, 137);
    assert.equal(killed.oomKilled, false);
    evidence.push("a forced container kill was observed as exit 137 with OOMKilled false");

    const recovery = await runDevrouter(["ensure", fixture, "--json"]);
    assert.equal(recovery.exitCode, 0, `fault-recovery ensure failed: ${recovery.stderrTail}`);
    assert.equal(
      containerIdFor(fixture),
      containerId,
      "recovery must start the retained container",
    );
    assert.equal(containerState(containerId).status, "running");
    assert.equal(adapterRuns(containerId), 3, "recovery must run the adapter again");
    assert.ok(execIn(containerId, `cat ${MARKER}`).length > 0, "retained marker missing");
    cohorts.recovery = cohort("fault-recovery ensure", recovery);
    containerFacts.recoveryMemory = containerMemory(containerId);
    containerFacts.journalAfterRecovery = journalState();
    evidence.push("fault-recovery started the same retained container with data intact");
  } catch (error) {
    failure = error;
  } finally {
    try {
      teardown = await runDevrouter(["stop", fixture, "--delete", "--json"]);
      assert.equal(teardown.exitCode, 0, `teardown failed: ${teardown.stderrTail}`);
      assert.equal(containerIdFor(fixture), undefined, "teardown must remove the container");
      evidence.push("the final delete removed the exact fixture container");
    } catch (error) {
      failure ??= error;
    }
  }

  const receipt = {
    schemaVersion: 1,
    fixture: { root, checkout: fixture, journalFile, image },
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
    },
    priorReleaseExitCode: priorRelease,
    containerId,
    containerFacts,
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
  console.error(error instanceof Error ? error.message : "Lifecycle-cohort qualification failed.");
  process.exitCode = 1;
});
