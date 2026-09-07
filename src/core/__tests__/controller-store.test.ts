import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomically } from "../atomic-file";
import { type ControllerSnapshot, ControllerStore } from "../controller-store";

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-store-test-"));
  directories.push(directory);
  return new ControllerStore(directory);
}
function acquire(snapshot: ControllerSnapshot) {
  snapshot.environments.push({
    id: "environment",
    repoPath: "/fixture/worktree",
    workspace: "fixture",
    provider: "devsy",
    providerId: "provider",
    profile: "web,test",
    fingerprint: "a".repeat(64),
  });
  snapshot.sessions.push({
    id: "client",
    environmentId: "environment",
    generation: "first",
    requirements: ["runtime"],
    renewedAtMs: 0,
  });
  snapshot.events.push({ sequence: 1, session: "client", generation: "first", kind: "acquired" });
  snapshot.nextSequence = 2;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
describe("controller snapshot durability", () => {
  it("advances the epoch with stable store identity and invalidates sessions on restart", () => {
    const store = fixture();
    const first = store.startIncarnation();
    acquire(first);
    store.persist(first);
    const second = store.startIncarnation();
    expect(second.store).toBe(first.store);
    expect(second.epoch).toBe(first.epoch + 1);
    expect(second.sessions).toEqual([]);
    expect(second.environments).toEqual([]);
    expect(second.events).toEqual([]);
    expect(store.read()).toEqual(second);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });
  it("preserves corruption and refuses startup", () => {
    const store = fixture();
    fs.writeFileSync(store.file, '{"version":99}', { mode: 0o600 });
    const before = fs.readFileSync(store.file);
    expect(() => store.startIncarnation()).toThrow();
    expect(fs.readFileSync(store.file)).toEqual(before);
  });
  it("rejects public files and symlinks without replacing their targets", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    fs.chmodSync(store.file, 0o644);
    expect(() => store.persist(snapshot)).toThrow();
    fs.renameSync(store.file, `${store.file}.target`);
    fs.symlinkSync(`${store.file}.target`, store.file);
    expect(() => store.startIncarnation()).toThrow();
    expect(fs.lstatSync(store.file).isSymbolicLink()).toBe(true);
  });
  it("preserves the previous snapshot when a pre-rename write fails", () => {
    const store = fixture();
    const first = store.startIncarnation();
    const broken = new ControllerStore(store.directory, () => {
      throw new Error("injected write failure");
    });
    expect(() => broken.startIncarnation()).toThrow();
    expect(store.read()).toEqual(first);
  });
  it("resyncs exact bytes after rename succeeded but write reported failure", () => {
    const store = fixture();
    store.startIncarnation();
    const uncertain = new ControllerStore(store.directory, (file, bytes) => {
      writeFileAtomically(file, bytes);
      throw new Error("injected post-rename sync failure");
    });
    const next = uncertain.startIncarnation();
    expect(next.epoch).toBe(2);
    expect(store.read()).toEqual(next);
  });
  it("rejects counter exhaustion without discarding existing state", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    snapshot.epoch = Number.MAX_SAFE_INTEGER;
    store.persist(snapshot);
    expect(() => store.startIncarnation()).toThrow();
    expect(store.read()).toEqual(snapshot);
  });
  it("rejects unsupported fields and dangling session bindings before writes", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    const bytes = fs.readFileSync(store.file);
    acquire(snapshot);
    snapshot.sessions[0].environmentId = "missing";
    expect(() => store.persist(snapshot)).toThrow();
    expect(() =>
      store.persist({ ...snapshot, transcript: "forbidden" } as ControllerSnapshot),
    ).toThrow();
    expect(fs.readFileSync(store.file)).toEqual(bytes);
  });
});
