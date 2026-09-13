import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../atomic-file";
import { ControllerSessions } from "../controller-sessions";
import { ControllerStore } from "../controller-store";

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-session-test-"));
  directories.push(directory);
  const store = new ControllerStore(directory);
  return { store, sessions: new ControllerSessions(store) };
}
const env = {
  id: "env",
  repoPath: "/fixture/checkout",
  workspace: "fixture",
  provider: "devsy" as const,
  providerId: "provider",
  profile: "web",
  fingerprint: "a".repeat(64),
};
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
it("shares compatible bindings and releases only the selected consumer", () => {
  const { sessions } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const second = sessions.acquire("two", env, ["app:web"], 0, 1000);
  expect(sessions.read().environments).toHaveLength(1);
  sessions.release(first, 1, 1001);
  expect(sessions.validate(second).id).toBe("two");
  expect(sessions.read().environments).toHaveLength(1);
  sessions.release(second, 2, 1002);
  expect(sessions.read().environments).toEqual([]);
});
it("observe retries and status reads do not extend leases", () => {
  const { sessions } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  sessions.tick(10_000, 11_000);
  expect(sessions.acquire("one", env, ["runtime"], 20_000, 21_000)).toEqual(first);
  sessions.read();
  sessions.tick(30_000, 31_000);
  expect(() => sessions.validate(first)).toThrow();
});
it("renew extends only its exact generation and rejects delayed replacement requests", () => {
  const { sessions } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  sessions.renew(first, 10_000, 11_000);
  sessions.tick(20_000, 21_000);
  sessions.tick(30_000, 31_000);
  expect(sessions.validate(first).id).toBe("one");
  sessions.release(first, 30_001, 31_001);
  const second = sessions.acquire("one", env, ["runtime"], 30_002, 31_002);
  expect(second.generation).not.toBe(first.generation);
  expect(() => sessions.renew(first, 30_003, 31_003)).toThrow();
  expect(sessions.validate(second).id).toBe("one");
});
it("rejects conflicts without contracting resources", () => {
  const { sessions } = fixture();
  sessions.acquire("one", env, ["runtime"], 0, 1000);
  expect(() =>
    sessions.acquire("two", { ...env, profile: "test" }, ["runtime"], 1, 1001),
  ).toThrow();
  expect(sessions.read().environments).toEqual([env]);
});
it("invalidates sessions on scheduling and wall-clock discontinuities", () => {
  for (const [mono, wall] of [
    [16_000, 17_000],
    [100, 5000],
    [100, 999],
  ]) {
    const { sessions } = fixture();
    const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
    expect(sessions.tick(mono, wall)).toBe(true);
    expect(() => sessions.validate(first)).toThrow();
  }
});
it("fences the old epoch from a replacement session after restart", () => {
  const { sessions, store } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const replacement = new ControllerSessions(store);
  const second = replacement.acquire("one", env, ["runtime"], 0, 1000);
  expect(second.epoch).toBe(first.epoch + 1);
  expect(() => replacement.renew(first, 1, 1001)).toThrow();
  replacement.release(first, 2, 1002);
  replacement.tick(3, 1003);
  expect(replacement.validate(second).id).toBe("one");
});

it("rejects excess sessions without evicting or changing acknowledged bindings", () => {
  const { sessions, store } = fixture();
  const bindings = Array.from({ length: 128 }, (_, index) =>
    sessions.acquire(`consumer-${index}`, env, ["runtime"], 0, 1000),
  );
  const before = fs.readFileSync(store.file);
  expect(() => sessions.acquire("overflow", env, ["runtime"], 0, 1000)).toThrow();
  expect(fs.readFileSync(store.file)).toEqual(before);
  for (const binding of bindings)
    expect(sessions.validate(binding).generation).toBe(binding.generation);
  for (const time of [10_000, 20_000, 30_000]) sessions.tick(time, time + 1000);
  expect(sessions.read().retainedSessions).toHaveLength(128);
  expect(() => sessions.acquire("overflow", env, ["runtime"], 30_001, 31_001)).toThrow();
  const replacement = sessions.reconnect(bindings[0], env, ["runtime"], 30_002, 31_002);
  expect(sessions.validate(replacement).parkingConsent).toBe("protected");
  expect(sessions.read().retainedSessions).toHaveLength(127);
  expect(sessions.read().sessions).toHaveLength(1);
  sessions.release(bindings[1], 30_003, 31_003);
  sessions.acquire("overflow", env, ["runtime"], 30_004, 31_004);
  expect(() => sessions.acquire("second-overflow", env, ["runtime"], 30_005, 31_005)).toThrow();
  expect(store.read()).toEqual(sessions.read());
});

it("caps environments while still accepting consumers of an existing environment", () => {
  const { sessions, store } = fixture();
  for (let index = 0; index < 32; index++)
    sessions.acquire(
      `consumer-${index}`,
      { ...env, id: `env-${index}`, repoPath: `/fixture/${index}` },
      ["runtime"],
      0,
      1000,
    );
  const before = fs.readFileSync(store.file);
  expect(() => sessions.acquire("overflow", env, ["runtime"], 0, 1000)).toThrow();
  expect(fs.readFileSync(store.file)).toEqual(before);
  const shared = sessions.acquire(
    "shared",
    { ...env, id: "env-0", repoPath: "/fixture/0" },
    ["runtime"],
    0,
    1000,
  );
  expect(sessions.validate(shared).environmentId).toBe("env-0");
  expect(sessions.read().environments).toHaveLength(32);
});

it("reports continuous grace without turning expiry or reacquisition into parking permission", () => {
  const { sessions, store } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  expect(sessions.protection(env, 0, 1000)).toMatchObject({
    liveConsumers: 1,
    protectedConsumers: 1,
    continuity: "continuity-unknown",
    graceRemainingMs: 60_000,
  });
  for (let time = 10_000; time <= 60_000; time += 10_000) sessions.renew(first, time, time + 1000);
  expect(sessions.protection(env, 60_000, 61_000).continuity).toBe("revalidation-required");
  sessions.tick(70_000, 71_000);
  sessions.tick(80_000, 81_000);
  sessions.tick(90_000, 91_000);
  const replacement = sessions.acquire("one", env, ["runtime"], 90_001, 91_001);
  expect(sessions.protection(env, 90_001, 91_001)).toMatchObject({
    liveConsumers: 1,
    protectedConsumers: 1,
    continuity: "orphan-suspected",
    graceRemainingMs: 59_999,
  });
  expect(() => sessions.validate(first)).toThrow();
  sessions.acquire("two", env, ["app:web"], 90_002, 91_002);
  sessions.release(replacement, 90_003, 91_003);
  expect(sessions.protection(env, 90_003, 91_003).liveConsumers).toBe(1);
  const restarted = new ControllerSessions(store);
  restarted.acquire("new", env, ["runtime"], 0, 200_000);
  expect(restarted.protection(env, 0, 200_000).continuity).toBe("continuity-unknown");
});

it("resets protection grace on sleep and refuses evidence for changed environments", () => {
  const { sessions } = fixture();
  sessions.acquire("one", env, ["runtime"], 0, 1000);
  sessions.tick(16_000, 17_000);
  sessions.acquire("two", env, ["runtime"], 16_001, 17_001);
  expect(sessions.protection(env, 16_001, 17_001)).toMatchObject({
    continuity: "continuity-unknown",
    graceRemainingMs: 59_999,
  });
  expect(() =>
    sessions.protection({ ...env, fingerprint: "b".repeat(64) }, 16_002, 17_002),
  ).toThrow();
});

it("requires explicit live consent and fences revocation against stale retries", () => {
  const { sessions, store } = fixture();
  const binding = sessions.acquire("one", env, ["runtime"], 0, 1000);
  expect(sessions.validate(binding)).toMatchObject({
    parkingConsent: "protected",
    consentRevision: 0,
  });
  expect(sessions.protection(env, 1, 1001).consentSatisfied).toBe(false);
  sessions.setParkingConsent(binding, 0, "allow-unusable", 2, 1002);
  expect(sessions.protection(env, 3, 1003).consentSatisfied).toBe(true);
  const before = fs.readFileSync(store.file);
  sessions.setParkingConsent(binding, 0, "allow-unusable", 4, 1004);
  expect(fs.readFileSync(store.file)).toEqual(before);
  sessions.setParkingConsent(binding, 1, "protected", 5, 1005);
  expect(() => sessions.setParkingConsent(binding, 0, "allow-unusable", 6, 1006)).toThrow();
  sessions.renew(binding, 7, 1007);
  expect(sessions.protection(env, 8, 1008).consentSatisfied).toBe(false);
});

it("retains expired protection despite a new opted-in consumer and acknowledges only the exact lost binding", () => {
  const { sessions } = fixture();
  const old = sessions.acquire("one", env, ["app:web"], 0, 1000);
  sessions.tick(10_000, 11_000);
  sessions.tick(20_000, 21_000);
  sessions.tick(30_000, 31_000);
  const other = sessions.acquire("two", env, ["runtime"], 30_001, 31_001);
  sessions.setParkingConsent(other, 0, "allow-unusable", 30_002, 31_002);
  expect(sessions.protection(env, 30_003, 31_003)).toMatchObject({
    unresolvedConsumers: 1,
    consentSatisfied: false,
  });
  const retained = sessions.read().retainedSessions;
  expect(() =>
    sessions.reconnect({ ...old, generation: "wrong" }, env, ["app:web"], 30_004, 31_004),
  ).toThrow();
  expect(() => sessions.reconnect(old, env, ["runtime"], 30_005, 31_005)).toThrow();
  expect(sessions.read().retainedSessions).toEqual(retained);
  const replacement = sessions.reconnect(old, env, ["app:web"], 30_006, 31_006);
  expect(replacement.generation).not.toBe(old.generation);
  expect(sessions.validate(replacement)).toMatchObject({
    parkingConsent: "protected",
    consentRevision: 0,
  });
  expect(() => sessions.setParkingConsent(old, 0, "allow-unusable", 30_007, 31_007)).toThrow();
  sessions.setParkingConsent(replacement, 0, "allow-unusable", 30_008, 31_008);
  expect(sessions.protection(env, 30_009, 31_009).consentSatisfied).toBe(true);
});

it("keeps ordinary observation available after drift without discarding lost consumers", () => {
  const { sessions, store } = fixture();
  const old = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const restarted = new ControllerSessions(store);
  const changed = { ...env, fingerprint: "b".repeat(64) };
  const current = restarted.acquire("two", changed, ["runtime"], 0, 2000);
  restarted.setParkingConsent(current, 0, "allow-unusable", 1, 2001);
  expect(restarted.protection(changed, 2, 2002)).toMatchObject({
    unresolvedConsumers: 1,
    consentSatisfied: false,
  });
  expect(() => restarted.reconnect(old, changed, ["runtime"], 3, 2003)).toThrow();
  restarted.release(current, 4, 2004);
  expect(restarted.read().sessions).toEqual([]);
  expect(restarted.read().retainedSessions).toHaveLength(1);
});

it("removes only acknowledged live releases and invalidates the prior complete-set revision", () => {
  const { sessions } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const second = sessions.acquire("two", env, ["runtime"], 0, 1000);
  sessions.setParkingConsent(second, 0, "allow-unusable", 1, 1001);
  const revision = sessions.read().parkingRevision;
  expect(sessions.protection(env, 2, 1002).consentSatisfied).toBe(false);
  sessions.release(first, 3, 1003);
  expect(sessions.read().parkingRevision).toBeGreaterThan(revision);
  expect(sessions.read().retainedSessions).toEqual([]);
  expect(sessions.protection(env, 4, 1004).consentSatisfied).toBe(true);
  sessions.release(second, 5, 1005);
  expect(sessions.read().sessions).toEqual([]);
});

it("retains binding invalidations and never clears legacy uncertainty through consent", () => {
  const { sessions, store } = fixture();
  sessions.acquire("one", env, ["runtime"], 0, 1000);
  sessions.invalidate(env.id, true);
  expect(sessions.read().retainedSessions).toHaveLength(1);
  const snapshot = store.read()!;
  snapshot.history = "legacy-unknown";
  store.persist(snapshot);
  const restarted = new ControllerSessions(store);
  const binding = restarted.acquire("two", env, ["runtime"], 0, 2000);
  restarted.setParkingConsent(binding, 0, "allow-unusable", 1, 2001);
  expect(restarted.protection(env, 2, 2002)).toMatchObject({
    history: "legacy-unknown",
    consentSatisfied: false,
  });
});

it.each([
  "consent",
  "reconnect",
] as const)("does not acknowledge %s when its durable write fails", (action) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-consent-failure-"));
  directories.push(directory);
  let fail = false;
  const store = new ControllerStore(directory, (file, bytes) => {
    if (fail) throw new Error("injected persistence failure");
    writeFileAtomically(file, bytes);
  });
  let sessions = new ControllerSessions(store);
  const old = sessions.acquire("one", env, ["runtime"], 0, 1000);
  if (action === "reconnect") sessions = new ControllerSessions(store);
  const before = fs.readFileSync(store.file);
  fail = true;
  expect(() =>
    action === "consent"
      ? sessions.setParkingConsent(old, 0, "allow-unusable", 1, 1001)
      : sessions.reconnect(old, env, ["runtime"], 1, 1001),
  ).toThrow();
  expect(fs.readFileSync(store.file)).toEqual(before);
  expect(() => sessions.read()).toThrow();
  fail = false;
  const restarted = new ControllerSessions(store);
  expect(restarted.read().retainedSessions).toMatchObject([
    { parkingConsent: "protected", generation: old.generation },
  ]);
});

it("retains pre-enrollment consumers even when synthetic environment fingerprints match", () => {
  const { store, sessions } = fixture();
  const old = sessions.acquire("old", env, ["runtime"], 0, 1000);
  const { fingerprint: _fingerprint, ...snapshot } = store.read()!;
  writeFileAtomically(
    store.file,
    JSON.stringify({ ...snapshot, version: 2, history: "legacy-unknown" }),
  );
  writeFileAtomically(
    path.join(store.directory, "store-identity.json"),
    JSON.stringify({ version: 1, store: old.store }),
  );
  const restarted = new ControllerSessions(new ControllerStore(store.directory));
  expect(() => restarted.reconnect(old, env, ["runtime"], 0, 1000)).toThrow();
  expect(restarted.read().retainedSessions).toHaveLength(1);
  expect(restarted.read().sessions).toHaveLength(0);
  restarted.release(old, 1, 1001);
  expect(restarted.read().retainedSessions).toEqual([]);
  expect(restarted.read().history).toBe("legacy-unknown");
});

it("acknowledges an exact retained consumer after drift while preserving a newer live generation", () => {
  const { sessions, store } = fixture();
  const old = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const restarted = new ControllerSessions(store);
  const changed = { ...env, fingerprint: "b".repeat(64) };
  const current = restarted.acquire("one", changed, ["runtime"], 0, 2000);
  const revision = restarted.read().parkingRevision;
  expect(() => restarted.reconnect(old, changed, ["runtime"], 1, 2001)).toThrow();
  restarted.release(old, 2, 2002);
  restarted.tick(3, 2003);
  expect(restarted.renew(current, 4, 2004)).toEqual(current);
  expect(restarted.read().retainedSessions).toEqual([]);
  expect(restarted.validate(current).generation).toBe(current.generation);
  expect(restarted.read().parkingRevision).toBeGreaterThan(revision);
  expect(restarted.read().events.find((event) => event.kind === "released")).toMatchObject({
    session: old.session,
    generation: old.generation,
    kind: "released",
  });
});

it.each([
  "store",
  "epoch",
  "generation",
  "session",
] as const)("refuses retained withdrawal with a mismatched %s and refuses replay", (field) => {
  const { sessions, store } = fixture();
  const old = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const restarted = new ControllerSessions(store);
  const before = fs.readFileSync(store.file);
  const wrong = { ...old, [field]: field === "epoch" ? old.epoch + 1 : "unknown" };
  expect(() => restarted.release(wrong, 0, 2000)).toThrow();
  expect(fs.readFileSync(store.file)).toEqual(before);
  restarted.release(old, 1, 2001);
  const released = fs.readFileSync(store.file);
  expect(() => restarted.release(old, 2, 2002)).toThrow();
  expect(fs.readFileSync(store.file)).toEqual(released);
});

it.each(["expired", "binding-changed"] as const)("withdraws exact %s protection", (reason) => {
  const { sessions } = fixture();
  const old = sessions.acquire("one", env, ["runtime"], 0, 1000);
  if (reason === "expired") {
    for (const now of [10_000, 20_000, 30_000]) sessions.tick(now, now + 1000);
  } else sessions.invalidate(env.id, true);
  expect(sessions.read().retainedSessions[0].reason).toBe(reason);
  const now = reason === "expired" ? 30_001 : 1;
  sessions.release(old, now, now + 1000);
  expect(sessions.read().retainedSessions).toEqual([]);
});

it.each([
  "before-write",
  "after-write",
] as const)("does not acknowledge retained withdrawal when persistence fails %s", (failure) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-release-failure-"));
  directories.push(directory);
  let fail = false;
  let resyncFails = false;
  const fsync = fs.fsyncSync;
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (resyncFails) throw new Error("injected sync failure");
    fsync(fd);
  });
  const store = new ControllerStore(directory, (file, bytes) => {
    if (fail && failure === "before-write") throw new Error("injected persistence failure");
    writeFileAtomically(file, bytes);
    if (fail) {
      resyncFails = true;
      throw new Error("injected post-write failure");
    }
  });
  const sessions = new ControllerSessions(store);
  const old = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const restarted = new ControllerSessions(store);
  fail = true;
  try {
    expect(() => restarted.release(old, 0, 2000)).toThrow();
    expect(() => restarted.read()).toThrow();
  } finally {
    sync.mockRestore();
  }
  fail = false;
  const recovered = new ControllerSessions(new ControllerStore(directory));
  expect(recovered.read().retainedSessions).toHaveLength(failure === "before-write" ? 1 : 0);
  expect(recovered.read().sessions).toEqual([]);
});
