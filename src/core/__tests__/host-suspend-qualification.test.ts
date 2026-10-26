import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleDigestMatches,
  firstSuspendAfter,
  type HeartbeatEvent,
  type PowerEvent,
  parseHeartbeatLog,
  parsePowerLog,
  validatePreSuspendHeartbeat,
} from "../../../scripts/qualify-host-suspend";

const at = (iso: string) => Date.parse(iso);

const heartbeat = (kind: HeartbeatEvent["kind"], iso: string): HeartbeatEvent => ({
  kind,
  atMs: at(iso),
  line: `${iso} ${kind === "renewed" ? "renewed suspend" : "renew refused: test"}`,
});

const power = (kind: PowerEvent["kind"], iso: string): PowerEvent => ({
  kind,
  atMs: at(iso),
  line: `${iso} ${kind}`,
});

describe("host suspend power evidence", () => {
  it("parses the event column exactly and ignores scheduled wake requests", () => {
    const events = parsePowerLog(
      [
        "2026-10-26 08:00:00 +0000 Sleep               \tMaintenance Sleep",
        "2026-10-26 08:00:01 +0000 Wake Requests       \tScheduled maintenance",
        "2026-10-26 08:00:02 +0000 DarkWake            \tPartial maintenance wake",
        "2026-10-26 08:05:00 +0000 Wake                \tUser opened the lid",
      ].join("\n"),
    );

    expect(events.map((event) => event.kind)).toEqual(["sleep", "dark-wake", "wake"]);
    expect(events.map((event) => event.atMs)).toEqual([
      at("2026-10-26T08:00:00Z"),
      at("2026-10-26T08:00:02Z"),
      at("2026-10-26T08:05:00Z"),
    ]);
  });

  it("keeps the first complete cycle after preparation even when later cycles exist", () => {
    const events = [
      power("sleep", "2026-10-26T07:59:00Z"),
      power("wake", "2026-10-26T07:59:10Z"),
      power("sleep", "2026-10-26T08:01:00Z"),
      power("dark-wake", "2026-10-26T08:03:00Z"),
      power("sleep", "2026-10-26T08:04:00Z"),
      power("wake", "2026-10-26T08:05:00Z"),
      power("sleep", "2026-10-26T09:00:00Z"),
      power("wake", "2026-10-26T09:10:00Z"),
    ];

    const selected = firstSuspendAfter(events, at("2026-10-26T08:00:00Z"));

    expect(selected).toMatchObject({ state: "ready" });
    if (selected.state !== "ready") throw new Error("expected a completed suspend");
    expect(selected.pair.sleep.atMs).toBe(at("2026-10-26T08:01:00Z"));
    expect(selected.pair.wake.atMs).toBe(at("2026-10-26T08:05:00Z"));
  });

  it("does not treat a dark wake or an incomplete sleep as completion", () => {
    const darkWakeOnly = firstSuspendAfter(
      [power("sleep", "2026-10-26T08:01:00Z"), power("dark-wake", "2026-10-26T08:02:00Z")],
      at("2026-10-26T08:00:00Z"),
    );
    const none = firstSuspendAfter([], at("2026-10-26T08:00:00Z"));

    expect(darkWakeOnly).toEqual({ state: "not-run", reason: "incomplete-suspend" });
    expect(none).toEqual({ state: "not-run", reason: "no-suspend" });
  });
});

describe("host suspend heartbeat evidence", () => {
  const preparedAtMs = at("2026-10-26T08:00:00Z");
  const sleepAtMs = at("2026-10-26T08:01:00Z");

  it("accepts a successful renewal inside the lease", () => {
    const events = parseHeartbeatLog(
      "2026-10-26T08:00:31.000Z renewed suspend\n2026-10-26T08:00:45.000Z renewed suspend",
    );

    expect(validatePreSuspendHeartbeat(events, preparedAtMs, sleepAtMs)).toMatchObject({
      ok: true,
      renewal: { atMs: at("2026-10-26T08:00:45Z") },
    });
  });

  it("rejects absent, invalid, stale, or refused renewal evidence", () => {
    const stale = [heartbeat("renewed", "2026-10-26T08:00:30Z")];
    const refused = [
      heartbeat("renewed", "2026-10-26T08:00:50Z"),
      heartbeat("refused", "2026-10-26T08:00:55Z"),
    ];

    expect(validatePreSuspendHeartbeat([], preparedAtMs, sleepAtMs)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(parseHeartbeatLog("not-a-timestamp renewed suspend")).toEqual([]);
    expect(validatePreSuspendHeartbeat(stale, preparedAtMs, sleepAtMs)).toMatchObject({
      ok: false,
      reason: "pre-expired",
    });
    expect(validatePreSuspendHeartbeat(refused, preparedAtMs, sleepAtMs)).toMatchObject({
      ok: false,
      reason: "refused",
      event: { kind: "refused" },
    });
  });

  it("treats the exact 30-second boundary as expired", () => {
    const exactBoundary = [heartbeat("renewed", "2026-10-26T08:00:30Z")];
    const insideBoundary = [heartbeat("renewed", "2026-10-26T08:00:30.001Z")];

    expect(validatePreSuspendHeartbeat(exactBoundary, preparedAtMs, sleepAtMs)).toMatchObject({
      ok: false,
      reason: "pre-expired",
    });
    expect(validatePreSuspendHeartbeat(insideBoundary, preparedAtMs, sleepAtMs)).toMatchObject({
      ok: true,
    });
  });

  it("ignores a refusal after the sleep while preserving the pre-sleep renewal", () => {
    const events = [
      heartbeat("renewed", "2026-10-26T08:00:50Z"),
      heartbeat("refused", "2026-10-26T08:01:01Z"),
    ];

    expect(validatePreSuspendHeartbeat(events, preparedAtMs, sleepAtMs)).toMatchObject({
      ok: true,
    });
  });
});

describe("host suspend bundle evidence", () => {
  it("accepts only an exact hexadecimal SHA-256 match", () => {
    const prepared = "a".repeat(64);

    expect(bundleDigestMatches(prepared, prepared)).toBe(true);
    expect(bundleDigestMatches(prepared, "b".repeat(64))).toBe(false);
    expect(bundleDigestMatches("not-a-digest", "not-a-digest")).toBe(false);
  });

  it("rejects a changed bundle before external commands or fixture mutation", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-host-suspend-"));
    const work = path.join(tempRoot, "work");
    const bin = path.join(tempRoot, "bin");
    const externalMarker = path.join(tempRoot, "external-tool-invoked");
    const cliMarker = path.join(tempRoot, "cli-invoked");
    fs.mkdirSync(work);
    fs.mkdirSync(bin);

    try {
      const dist = path.join(tempRoot, "changed-dist.cjs");
      const distSource = `require("node:fs").writeFileSync(${JSON.stringify(cliMarker)}, "invoked");\n`;
      fs.writeFileSync(dist, distSource);
      const preparedAtMs = Date.now();
      const checkpoint = {
        schema: "devrouter.host-suspend.checkpoint.v1",
        preparedAtMs,
        preparedAt: new Date(preparedAtMs).toISOString(),
        revision: "0".repeat(40),
        distSha256: createHash("sha256").update(`stale-${distSource}`).digest("hex"),
        home: path.join(work, "home"),
        controller: {
          pid: 1,
          socket: path.join(work, "control.sock"),
          checkout: path.join(work, "checkout"),
          store: "store",
          epoch: 1,
          generation: "generation",
          session: "suspend",
        },
        protection: {
          measuredAtMs: preparedAtMs - 1,
          continuity: "continuity-unknown",
          graceRemainingMs: 0,
          liveConsumers: 1,
        },
        live: {
          repo: path.join(work, "live"),
          url: "https://host-suspend.localhost",
          container: "fixture",
          token: "token",
          composeFiles: "",
        },
        powerBefore: [],
      };
      const checkpointPath = path.join(work, "checkpoint.json");
      const checkpointBytes = `${JSON.stringify(checkpoint, null, 2)}\n`;
      const fixturePath = path.join(work, "fixture-sentinel.txt");
      const fixtureBytes = "do not mutate\n";
      fs.writeFileSync(checkpointPath, checkpointBytes);
      fs.writeFileSync(fixturePath, fixtureBytes);
      const entriesBefore = fs.readdirSync(work).sort();

      for (const name of ["pmset", "mkcert", "docker", "curl", "git", "ps"]) {
        fs.writeFileSync(
          path.join(bin, name),
          `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(externalMarker)}, ${JSON.stringify(`${name}\n`)});\n`,
          { mode: 0o700 },
        );
      }

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("scripts/qualify-host-suspend.ts"), "verify"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DR_HS_DIST: dist,
            DR_HS_WORK: work,
            LC_ALL: "C",
            NODE_OPTIONS: "",
            PATH: bin,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(fs.existsSync(externalMarker)).toBe(false);
      expect(fs.existsSync(cliMarker)).toBe(false);
      expect(fs.existsSync(path.join(work, "receipt.json"))).toBe(false);
      expect(fs.readdirSync(work).sort()).toEqual(entriesBefore);
      expect(fs.readFileSync(checkpointPath, "utf8")).toBe(checkpointBytes);
      expect(fs.readFileSync(fixturePath, "utf8")).toBe(fixtureBytes);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
