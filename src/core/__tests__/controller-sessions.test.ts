import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
it("requires explicit reacquisition after restart, fencing the old epoch", () => {
  const { sessions, store } = fixture();
  const first = sessions.acquire("one", env, ["runtime"], 0, 1000);
  const replacement = new ControllerSessions(store);
  const second = replacement.acquire("one", env, ["runtime"], 0, 1000);
  expect(second.epoch).toBe(first.epoch + 1);
  expect(() => replacement.release(first, 1, 1001)).toThrow();
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
