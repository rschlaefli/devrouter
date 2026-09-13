import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomically } from "../atomic-file";
import {
  type ControllerEnvironment,
  type ControllerRetainedSession,
  type ControllerSnapshot,
  ControllerStore,
  validateControllerSnapshot,
} from "../controller-store";

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-store-test-"));
  directories.push(directory);
  return new ControllerStore(directory);
}
function environment(index = 0): ControllerEnvironment {
  return {
    id: index === 0 ? "environment" : `environment-${index}`,
    repoPath: index === 0 ? "/fixture/worktree" : `/fixture/worktree-${index}`,
    workspace: index === 0 ? "fixture" : `fixture-${index}`,
    provider: "devsy",
    providerId: index === 0 ? "provider" : `provider-${index}`,
    profile: "web,test",
    fingerprint: "a".repeat(64),
  };
}
function retained(overrides: Partial<ControllerRetainedSession> = {}): ControllerRetainedSession {
  return {
    id: "client",
    generation: "first",
    epoch: 1,
    requirements: ["runtime"],
    parkingConsent: "protected",
    consentRevision: 0,
    reason: "expired",
    environment: environment(),
    ...overrides,
  };
}
function acquire(snapshot: ControllerSnapshot) {
  snapshot.environments.push(environment());
  snapshot.sessions.push({
    id: "client",
    environmentId: "environment",
    generation: "first",
    requirements: ["runtime"],
    renewedAtMs: 0,
    parkingConsent: "protected",
    consentRevision: 0,
  });
  snapshot.events.push({ sequence: 1, session: "client", generation: "first", kind: "acquired" });
  snapshot.nextSequence = 2;
}
function legacySnapshot() {
  return {
    version: 1,
    store: "legacy-store",
    epoch: 4,
    revision: 7,
    nextSequence: 2,
    environments: [environment()],
    sessions: [
      {
        id: "client",
        environmentId: "environment",
        generation: "first",
        requirements: ["runtime"],
        renewedAtMs: 0,
      },
    ],
    events: [{ sequence: 1, session: "client", generation: "first", kind: "acquired" }],
  };
}
function writeLegacy(store: ControllerStore) {
  const contents = `${JSON.stringify(legacySnapshot())}\n`;
  fs.writeFileSync(store.file, contents, { mode: 0o600 });
  return contents;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
describe("controller snapshot durability", () => {
  it("refuses missing established history on both restart and an existing writer", () => {
    const store = fixture();
    const first = store.startIncarnation();
    acquire(first);
    store.persist(first);
    fs.unlinkSync(store.file);
    expect(() => new ControllerStore(store.directory).startIncarnation()).toThrow();
    expect(() => store.persist(first)).toThrow();
    expect(fs.existsSync(store.file)).toBe(false);
  });
  it("initializes with operator policy and enrolls both private artifacts", () => {
    const store = fixture();
    fs.writeFileSync(path.join(store.directory, "capacity-policy.json"), "{}", { mode: 0o600 });
    const snapshot = store.startIncarnation();
    const identity = path.join(store.directory, "store-identity.json");
    expect(JSON.parse(fs.readFileSync(identity, "utf8"))).toMatchObject({
      version: 2,
      store: snapshot.store,
      enrolledEpoch: 1,
    });
    expect(fs.statSync(identity).mode & 0o777).toBe(0o600);
    expect(snapshot.history).toBe("complete");
  });
  it.each([
    "capacity-reservations.json",
    "owner.lock",
    ".snapshot.interrupted.tmp",
  ])("refuses fresh initialization with surviving %s evidence", (name) => {
    const store = fixture();
    const artifact = path.join(store.directory, name);
    fs.writeFileSync(artifact, "retained evidence", { mode: 0o600 });
    expect(() => store.startIncarnation()).toThrow();
    expect(fs.readFileSync(artifact, "utf8")).toBe("retained evidence");
    expect(fs.existsSync(store.file)).toBe(false);
  });
  it("refuses a lost marker in the running writer", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    const before = fs.readFileSync(store.file);
    fs.unlinkSync(path.join(store.directory, "store-identity.json"));
    expect(() => store.persist(snapshot)).toThrow();
    expect(fs.readFileSync(store.file)).toEqual(before);
  });
  it("refuses legacy history lost after the read-only startup preflight", () => {
    const store = fixture();
    writeLegacy(store);
    store.assertStartup();
    fs.unlinkSync(store.file);
    expect(() => store.startIncarnation()).toThrow();
    expect(fs.readdirSync(store.directory)).toEqual([]);
  });
  it.each([
    "mismatch",
    "corrupt",
    "extra-field",
    "public",
    "symlink",
    "oversized",
  ])("refuses a %s identity marker without replacing either artifact", (mode) => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    const identity = path.join(store.directory, "store-identity.json");
    if (mode === "mismatch")
      fs.writeFileSync(identity, JSON.stringify({ version: 1, store: "different" }));
    if (mode === "corrupt") fs.writeFileSync(identity, "{");
    if (mode === "extra-field")
      fs.writeFileSync(
        identity,
        JSON.stringify({ version: 1, store: snapshot.store, extra: true }),
      );
    if (mode === "public") fs.chmodSync(identity, 0o644);
    if (mode === "oversized") fs.writeFileSync(identity, " ".repeat(4097));
    if (mode === "symlink") {
      fs.renameSync(identity, `${identity}.target`);
      fs.symlinkSync(`${identity}.target`, identity);
    }
    const before = fs.readFileSync(store.file);
    const marker = fs.readFileSync(identity);
    expect(() => new ControllerStore(store.directory).startIncarnation()).toThrow();
    expect(fs.readFileSync(store.file)).toEqual(before);
    expect(fs.readFileSync(identity)).toEqual(marker);
  });
  it.each([false, true])("resumes interrupted marker enrollment (renamed: %s)", (renamed) => {
    const store = fixture();
    const interrupted = new ControllerStore(store.directory, (file, bytes) => {
      if (path.basename(file) !== "store-identity.json") return writeFileAtomically(file, bytes);
      if (renamed) writeFileAtomically(file, bytes);
      throw new Error("injected marker commit failure");
    });
    if (renamed) expect(interrupted.startIncarnation().epoch).toBe(1);
    else expect(() => interrupted.startIncarnation()).toThrow();
    const first = store.read()!;
    const resumed = new ControllerStore(store.directory).startIncarnation();
    expect(resumed.store).toBe(first.store);
    expect(resumed.epoch).toBe(first.epoch + 1);
    expect(resumed.history).toBe("complete");
  });
  it("advances the epoch with stable store identity and retains sessions on restart", () => {
    const store = fixture();
    const first = store.startIncarnation();
    expect(first).toMatchObject({
      version: 3,
      epoch: 1,
      parkingRevision: 0,
      history: "complete",
      retainedSessions: [],
    });
    acquire(first);
    store.persist(first);
    const second = store.startIncarnation();
    expect(second.store).toBe(first.store);
    expect(second.epoch).toBe(first.epoch + 1);
    expect(second.sessions).toEqual([]);
    expect(second.environments).toEqual([]);
    expect(second.events).toEqual([]);
    expect(second.retainedSessions).toEqual([
      {
        id: "client",
        generation: "first",
        epoch: first.epoch,
        requirements: ["runtime"],
        parkingConsent: "protected",
        consentRevision: 0,
        reason: "restart",
        environment: environment(),
      },
    ]);
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
  it("rejects a reported post-rename failure when a different valid snapshot is installed", () => {
    const store = fixture();
    store.startIncarnation();
    const broken = new ControllerStore(store.directory, (file, bytes) => {
      const installed = JSON.parse(bytes) as ControllerSnapshot;
      installed.revision += 1;
      writeFileAtomically(file, `${JSON.stringify(installed)}\n`);
      throw new Error("injected post-rename replacement failure");
    });

    expect(() => broken.startIncarnation()).toThrow("Controller snapshot commit failed.");
    expect(store.read()).toMatchObject({ epoch: 2, revision: 3 });
  });
  it.each([
    "epoch",
    "revision",
    "parkingRevision",
  ] as const)("rejects %s exhaustion without discarding existing state", (counter) => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    snapshot[counter] = Number.MAX_SAFE_INTEGER;
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
      store.persist({ ...snapshot, transcript: "forbidden" } as unknown as ControllerSnapshot),
    ).toThrow();
    expect(fs.readFileSync(store.file)).toEqual(bytes);
  });
});
describe("controller consent snapshot contract", () => {
  it("normalizes a legacy version1 store on read without writing, retaining, or advancing", () => {
    const store = fixture();
    const contents = writeLegacy(store);
    const first = store.read();
    expect(first).toMatchObject({
      version: 2,
      history: "legacy-unknown",
      epoch: 4,
      revision: 7,
      parkingRevision: 0,
      retainedSessions: [],
    });
    expect(first?.sessions).toEqual([
      {
        id: "client",
        environmentId: "environment",
        generation: "first",
        requirements: ["runtime"],
        renewedAtMs: 0,
        parkingConsent: "protected",
        consentRevision: 0,
      },
    ]);
    const second = store.read();
    expect(second).toEqual(first);
    expect(fs.readFileSync(store.file, "utf8")).toBe(contents);
  });
  it("retains legacy sessions as protected records once at startup and never duplicates them", () => {
    const store = fixture();
    writeLegacy(store);
    const started = store.startIncarnation();
    expect(started).toMatchObject({
      version: 3,
      epoch: 5,
      parkingRevision: 1,
      history: "legacy-unknown",
    });
    expect(started.sessions).toEqual([]);
    expect(started.environments).toEqual([]);
    expect(started.retainedSessions).toEqual([
      {
        id: "client",
        generation: "first",
        epoch: 4,
        requirements: ["runtime"],
        parkingConsent: "protected",
        consentRevision: 0,
        reason: "restart",
        environment: environment(),
      },
    ]);
    const again = store.startIncarnation();
    expect(again.epoch).toBe(6);
    expect(again.retainedSessions).toEqual(started.retainedSessions);
    expect(store.read()).toEqual(again);
  });
  it("preserves legacy version1 bytes when a pre-rename write fails", () => {
    const store = fixture();
    const contents = writeLegacy(store);
    const broken = new ControllerStore(store.directory, () => {
      throw new Error("injected pre-rename failure");
    });
    expect(() => broken.startIncarnation()).toThrow("Controller snapshot commit failed.");
    expect(fs.readFileSync(store.file, "utf8")).toBe(contents);
    expect(store.read()?.retainedSessions).toEqual([]);
  });
  it("acknowledges only exact version3 bytes after a reported post-rename failure", () => {
    const store = fixture();
    writeLegacy(store);
    const uncertain = new ControllerStore(store.directory, (file, bytes) => {
      writeFileAtomically(file, bytes);
      throw new Error("injected post-rename failure");
    });
    const next = uncertain.startIncarnation();
    expect(next).toMatchObject({ version: 3, epoch: 5, parkingRevision: 1 });
    expect(JSON.parse(fs.readFileSync(store.file, "utf8"))).toEqual(next);
  });
  it("rejects a normalized legacy view as proof of a version3 commit", () => {
    const store = fixture();
    writeLegacy(store);
    const normalized = store.read() as ControllerSnapshot;
    const broken = new ControllerStore(store.directory, (file, bytes) => {
      if (file !== store.file) return writeFileAtomically(file, bytes);
      writeFileAtomically(file, `${JSON.stringify(normalized)}\n`);
      throw new Error("installed normalized view");
    });
    expect(() => broken.startIncarnation()).toThrow("Controller snapshot commit failed.");
    expect(JSON.parse(fs.readFileSync(store.file, "utf8"))).toEqual(normalized);
  });
  it("bounds the combined active and retained entry count at 128", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    acquire(snapshot);
    for (let index = 0; index < 127; index++)
      snapshot.retainedSessions.push(
        retained({ id: `retained-${index}`, generation: `generation-${index}` }),
      );
    store.persist(snapshot);
    expect(store.read()?.retainedSessions).toHaveLength(127);
    const beyond = store.read() as ControllerSnapshot;
    beyond.retainedSessions.push(
      retained({ id: "retained-extra", generation: "generation-extra" }),
    );
    expect(() => store.persist(beyond)).toThrow();
  });
  it("bounds distinct logical environments and reconciles id and path mappings", () => {
    const store = fixture();
    const accepted = store.startIncarnation();
    acquire(accepted);
    accepted.retainedSessions.push(
      retained({
        generation: "drift",
        environment: { ...environment(), profile: "web", fingerprint: "b".repeat(64) },
      }),
    );
    for (let index = 1; index <= 31; index++)
      accepted.retainedSessions.push(
        retained({
          id: `client-${index}`,
          generation: `generation-${index}`,
          environment: environment(index),
        }),
      );
    store.persist(accepted);
    expect(store.read()?.retainedSessions).toHaveLength(32);

    const conflictingId = store.read() as ControllerSnapshot;
    conflictingId.retainedSessions.push(
      retained({ id: "other", environment: { ...environment(), repoPath: "/fixture/other" } }),
    );
    expect(() => store.persist(conflictingId)).toThrow();

    const conflictingPath = store.read() as ControllerSnapshot;
    conflictingPath.retainedSessions.push(
      retained({ id: "other", environment: { ...environment(), id: "other" } }),
    );
    expect(() => store.persist(conflictingPath)).toThrow();

    const beyond = store.read() as ControllerSnapshot;
    beyond.retainedSessions.push(
      retained({ id: "beyond", generation: "beyond", environment: environment(32) }),
    );
    expect(() => store.persist(beyond)).toThrow();
  });
  it("refuses retained bindings from an impossible future epoch", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    snapshot.retainedSessions.push(retained({ epoch: snapshot.epoch }));
    store.persist(snapshot);
    expect(store.read()?.retainedSessions).toHaveLength(1);

    const future = store.read() as ControllerSnapshot;
    future.retainedSessions.push(
      retained({ id: "future", generation: "future", epoch: snapshot.epoch + 1 }),
    );
    expect(() => store.persist(future)).toThrow();
  });
  it("requires unique binding tuples while allowing multiple generations of one name", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    snapshot.retainedSessions.push(retained({ generation: "first" }));
    snapshot.retainedSessions.push(retained({ generation: "second" }));
    store.persist(snapshot);
    expect(store.read()?.retainedSessions).toHaveLength(2);

    const duplicate = store.read() as ControllerSnapshot;
    duplicate.retainedSessions.push(retained({ generation: "first" }));
    expect(() => store.persist(duplicate)).toThrow();

    const activeCollision = store.startIncarnation();
    acquire(activeCollision);
    activeCollision.retainedSessions.push(
      retained({ epoch: activeCollision.epoch, generation: "first" }),
    );
    expect(() => store.persist(activeCollision)).toThrow();
  });
  it("validates parking consent, retained reasons, and the extended event kinds", () => {
    const store = fixture();
    const snapshot = store.startIncarnation();
    acquire(snapshot);
    snapshot.sessions[0].parkingConsent = "allow-unusable";
    snapshot.sessions[0].consentRevision = 3;
    snapshot.events.push({ sequence: 2, session: "client", generation: "first", kind: "consent" });
    snapshot.events.push({
      sequence: 3,
      session: "client",
      generation: "first",
      kind: "reconnected",
    });
    snapshot.nextSequence = 4;
    store.persist(snapshot);
    expect(store.read()?.sessions[0]).toMatchObject({
      parkingConsent: "allow-unusable",
      consentRevision: 3,
    });

    const invalidConsent = store.read() as ControllerSnapshot;
    invalidConsent.sessions[0].parkingConsent = "granted" as never;
    expect(() => store.persist(invalidConsent)).toThrow();

    const invalidKind = store.read() as ControllerSnapshot;
    invalidKind.events[0].kind = "submitted" as never;
    expect(() => store.persist(invalidKind)).toThrow();

    const invalidReason = store.read() as ControllerSnapshot;
    invalidReason.retainedSessions.push(
      retained({ id: "retained", generation: "retained", reason: "parked" as never }),
    );
    expect(() => store.persist(invalidReason)).toThrow();
  });
  it("validates snapshots by exact version in both directions", () => {
    const store = fixture();
    const current = store.startIncarnation();
    // The version1-exact read path refuses version2 content.
    fs.writeFileSync(store.file, `${JSON.stringify({ ...current, version: 1 })}\n`, {
      mode: 0o600,
    });
    expect(() => store.read()).toThrow("Controller snapshot is unreadable or invalid.");
    // The strict version2 validator refuses a version1 shape, relabelled or not.
    expect(() => validateControllerSnapshot(legacySnapshot())).toThrow();
    fs.writeFileSync(store.file, `${JSON.stringify({ ...legacySnapshot(), version: 2 })}\n`, {
      mode: 0o600,
    });
    expect(() => store.read()).toThrow("Controller snapshot is unreadable or invalid.");
  });
});

describe("durable controller binding fingerprints", () => {
  it("keeps identical fingerprints across incarnations while fencing an old closure", () => {
    const store = fixture();
    store.startIncarnation();
    const first = store.bindingFingerprint();
    const fingerprint = first("synthetic-owner", "synthetic-config");
    const restarted = new ControllerStore(store.directory);
    restarted.startIncarnation();
    expect(restarted.bindingFingerprint()("synthetic-owner", "synthetic-config")).toBe(fingerprint);
    expect(restarted.bindingFingerprint()("synthetic-owner", "changed-config")).not.toBe(
      fingerprint,
    );
    expect(() => first("synthetic-owner", "synthetic-config")).toThrow();
  });
});

it.each([
  "missing",
  "key",
  "epoch",
  "downgrade",
  "snapshot-downgrade",
])("invalidates held fingerprints and refuses restart after %s provenance", (change) => {
  const store = fixture();
  const snapshot = store.startIncarnation();
  const fingerprint = store.bindingFingerprint();
  const identityFile = path.join(store.directory, "store-identity.json");
  const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  if (change === "missing") fs.unlinkSync(identityFile);
  if (change === "key")
    writeFileAtomically(identityFile, JSON.stringify({ ...identity, key: "0".repeat(64) }));
  if (change === "epoch")
    writeFileAtomically(
      identityFile,
      JSON.stringify({ ...identity, enrolledEpoch: identity.enrolledEpoch + 1 }),
    );
  if (change === "downgrade")
    writeFileAtomically(identityFile, JSON.stringify({ version: 1, store: identity.store }));
  if (change === "snapshot-downgrade") {
    const { fingerprint: _fingerprint, ...legacy } = snapshot;
    writeFileAtomically(store.file, JSON.stringify({ ...legacy, version: 2 }));
  }
  const before = fs.readFileSync(store.file);
  expect(() => fingerprint("owner", "config")).toThrow();
  expect(() => store.persist(snapshot)).toThrow();
  expect(() => new ControllerStore(store.directory).startIncarnation()).toThrow();
  expect(fs.readFileSync(store.file)).toEqual(before);
});

it.each([
  1, 2,
])("enrolls version%s history without reconnect provenance for older epochs", (version) => {
  const store = fixture();
  writeLegacy(store);
  if (version === 2) writeFileAtomically(store.file, JSON.stringify(store.read()));
  writeFileAtomically(
    path.join(store.directory, "store-identity.json"),
    JSON.stringify({ version: 1, store: "legacy-store" }),
  );
  const before = fs.readFileSync(store.file);
  expect(store.read()?.version).toBe(2);
  expect(fs.readFileSync(store.file)).toEqual(before);
  const migrated = store.startIncarnation();
  expect(migrated.version).toBe(3);
  expect(migrated.fingerprint?.enrolledEpoch).toBe(5);
  expect(migrated.retainedSessions[0].epoch).toBe(4);
  const key = JSON.parse(
    fs.readFileSync(path.join(store.directory, "store-identity.json"), "utf8"),
  ).key;
  expect(typeof key === "string" && /^[a-f0-9]{64}$/.test(key)).toBe(true);
  expect(JSON.stringify(migrated).includes(key)).toBe(false);
  const other = fixture();
  other.startIncarnation();
  expect(other.bindingFingerprint()("owner", "config")).not.toBe(
    store.bindingFingerprint()("owner", "config"),
  );
});

it.each([
  false,
  true,
])("resumes the same enrolled key after a version3 write failure (renamed: %s)", (renamed) => {
  const store = fixture();
  writeLegacy(store);
  const broken = new ControllerStore(store.directory, (file, bytes) => {
    if (file !== store.file) return writeFileAtomically(file, bytes);
    if (renamed) writeFileAtomically(file, bytes);
    throw new Error("synthetic write failure");
  });
  if (renamed) expect(broken.startIncarnation().epoch).toBe(5);
  else expect(() => broken.startIncarnation()).toThrow();
  const marker = fs.readFileSync(path.join(store.directory, "store-identity.json"));
  const resumed = new ControllerStore(store.directory);
  const snapshot = resumed.startIncarnation();
  expect(snapshot.fingerprint?.enrolledEpoch).toBe(5);
  expect(snapshot.epoch).toBe(renamed ? 6 : 5);
  expect(snapshot.retainedSessions).toHaveLength(1);
  expect(fs.readFileSync(path.join(store.directory, "store-identity.json"))).toEqual(marker);
});

it("rejects a migrated identity with an impossible pending epoch without replacing history", () => {
  const store = fixture();
  const contents = writeLegacy(store);
  writeFileAtomically(
    path.join(store.directory, "store-identity.json"),
    JSON.stringify({
      version: 2,
      store: "legacy-store",
      key: "a".repeat(64),
      enrolledEpoch: 4,
    }),
  );
  expect(() => store.startIncarnation()).toThrow();
  expect(fs.readFileSync(store.file, "utf8")).toBe(contents);
});
