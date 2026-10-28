import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewWriteGate } from "../engine";
import { commandImageBackend } from "../image-command";
import { createPreviewSession } from "../lifecycle";
import type { PreviewPoolEntry } from "../state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const producer = {
  repository: "example/repo",
  workflow: ".github/workflows/images.yml",
  controlRevision: "b".repeat(40),
};
function fixture(mode: "ready" | "missing" | "uncertain") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-image-command-"));
  roots.push(root);
  const script = path.join(root, "resolver.cjs");
  fs.writeFileSync(
    script,
    `const fs=require("node:fs");const input=JSON.parse(fs.readFileSync(0,"utf8"));
    fs.appendFileSync("calls",input.action+"\\n");
    if(input.action==="dispatch"){if(${JSON.stringify(mode)}==="uncertain")process.exit(1);process.stdout.write("{}");}
    else process.stdout.write(JSON.stringify({receipts:${mode === "ready" ? `[{...input.producer,revision:input.request.revision,runId:"7",attempt:1,target:"web",platform:input.request.platform,configurationDigest:"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",inputFingerprint:"sha256:"+"1".repeat(64),image:"registry.example/example/repo/web@sha256:"+"2".repeat(64),ciPassed:true,admissionPassed:true}]` : "[]"},pending:false}));`,
  );
  let intent = false;
  const records: string[] = [];
  const gate: PreviewWriteGate = {
    read: async () => [],
    fenced: async () => false,
    begin: async () => {
      if (intent) return "resolve";
      intent = true;
      return "write";
    },
    record: async (_name, status) => {
      records.push(status);
    },
  };
  const revision = "a".repeat(40);
  const entry: PreviewPoolEntry = {
    session: createPreviewSession({
      generation: "c".repeat(24),
      now: 1,
      revision,
      aliases: ["web"],
      commandId: "start",
    }),
    plan: {
      schemaVersion: 1,
      status: "planned",
      aliases: ["web"],
      resources: [{ id: "web", kind: "service", imageTarget: "web" }],
      reasons: [],
      omissions: [],
      manifestDigest: "d".repeat(64),
      localConfigDigest: "e".repeat(64),
      source: {
        head: revision,
        target: "b".repeat(40),
        mergeBase: "c".repeat(40),
        complete: true,
        changes: [],
      },
    },
    reservedCents: 1,
    hourlyCents: 1,
    operations: {},
    effectSequence: 0,
  };
  const backend = commandImageBackend({
    command: [process.execPath, script],
    files: [
      { path: script, sha256: createHash("sha256").update(fs.readFileSync(script)).digest("hex") },
    ],
    cwd: root,
    environment: { PATH: process.env.PATH },
    producer,
    platform: "linux/amd64",
    context: () => ({}),
  });
  return {
    backend,
    entry,
    gate,
    records,
    script,
    calls: () => fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n"),
  };
}
describe("installed image command", () => {
  it("reuses a compatible successful image without dispatch", async () => {
    const f = fixture("ready");
    const result = await f.backend.prepare(f.entry, f.gate);
    expect(result.phase).toBe("ready");
    expect(f.calls()).toEqual(["resolve"]);
    expect(f.records).toEqual([]);
  });
  it("dispatches a missing target once across repeated recovery", async () => {
    const f = fixture("missing");
    await f.backend.prepare(f.entry, f.gate);
    await f.backend.prepare(f.entry, f.gate);
    expect(f.calls()).toEqual(["resolve", "dispatch", "resolve"]);
    expect(f.records).toEqual(["accepted"]);
  });
  it("never redispatches an uncertain outcome when observation finds no run", async () => {
    const f = fixture("uncertain");
    await expect(f.backend.prepare(f.entry, f.gate)).rejects.toThrow("uncertain");
    await f.backend.prepare(f.entry, f.gate);
    expect(f.calls()).toEqual(["resolve", "dispatch", "resolve"]);
    expect(f.records).toEqual(["uncertain"]);
  });
  it("rejects a changed installed resolver before executing it", async () => {
    const f = fixture("ready");
    fs.appendFileSync(f.script, "\n// changed");
    await expect(f.backend.prepare(f.entry, f.gate)).rejects.toThrow("fingerprint");
  });
});
