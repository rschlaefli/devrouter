import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../atomic-file";
import {
  type ReliabilityIdentity,
  readReliabilityOperation,
  reliabilityOperationPath,
  updateReliabilityOperation,
  withReliabilityObservationFence,
} from "../reliability-operation-store";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../router", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "reliability-store-"));
  return { DEVROUTER_HOME: fixture.root };
});
vi.mock("../atomic-file", async (original) => {
  const actual = await original<typeof import("../atomic-file")>();
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) };
});

let identity: ReliabilityIdentity;
beforeEach(() => {
  identity = {
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "reliability-checkout-")),
    workspace: null,
    provider: "devsy",
  };
});
const checkouts: string[] = [];
beforeEach(() => checkouts.push(identity.repoPath));
afterAll(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  for (const checkout of checkouts) fs.rmSync(checkout, { recursive: true, force: true });
});

describe("durable reliability records", () => {
  it("writes private bounded manual state and refuses mismatched provider ownership", () => {
    expect(readReliabilityOperation(identity)).toBeUndefined();
    updateReliabilityOperation(identity, () => undefined);
    const record = readReliabilityOperation(identity);
    expect(record).toMatchObject({
      revision: 1,
      state: { executionPolicy: "manual", admission: "not-applicable" },
    });
    expect(fs.statSync(reliabilityOperationPath(identity)).mode & 0o777).toBe(0o600);
    expect(() => readReliabilityOperation({ ...identity, provider: "devpod" })).toThrow();
  });

  it("does not persist raw fields or redirect an update to another identity", () => {
    updateReliabilityOperation(identity, () => undefined);
    const original = fs.readFileSync(reliabilityOperationPath(identity), "utf8");
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        Object.assign(record.state, { argv: ["synthetic-payload"] });
      }),
    ).toThrow();
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.identity.repoPath = path.join(identity.repoPath, "other");
      }),
    ).toThrow();
    expect(fs.readFileSync(reliabilityOperationPath(identity), "utf8")).toBe(original);
  });

  it("rejects malformed, oversize, symlinked and non-private persisted records", () => {
    updateReliabilityOperation(identity, () => undefined);
    const file = reliabilityOperationPath(identity);
    const valid = fs.readFileSync(file);
    fs.writeFileSync(file, "{");
    expect(() => readReliabilityOperation(identity)).toThrow();
    fs.writeFileSync(file, Buffer.alloc(1_048_577));
    expect(() => readReliabilityOperation(identity)).toThrow();
    fs.writeFileSync(file, valid);
    fs.chmodSync(file, 0o644);
    expect(() => readReliabilityOperation(identity)).toThrow();
    fs.renameSync(file, `${file}.saved`);
    fs.symlinkSync(`${file}.saved`, file);
    expect(() => readReliabilityOperation(identity)).toThrow();
  });

  it("never acknowledges a failed write before rename", () => {
    updateReliabilityOperation(identity, () => undefined);
    vi.mocked(writeFileAtomically).mockImplementationOnce(() => {
      throw new Error("fixture before rename");
    });
    expect(() =>
      updateReliabilityOperation(identity, (record) => {
        record.effectSequence += 1;
      }),
    ).toThrow();
    expect(readReliabilityOperation(identity)).toMatchObject({ revision: 1, effectSequence: 0 });
  });

  it("recovers a post-rename error only by syncing the exact newly persisted record", async () => {
    const actual = await vi.importActual<typeof import("../atomic-file")>("../atomic-file");
    vi.mocked(writeFileAtomically).mockImplementationOnce((file, contents) => {
      actual.writeFileAtomically(file, contents);
      throw new Error("fixture after rename");
    });
    updateReliabilityOperation(identity, (record) => {
      record.effectSequence = 1;
    });
    expect(readReliabilityOperation(identity)).toMatchObject({ revision: 1, effectSequence: 1 });
  });

  it("refuses acknowledgement when the post-rename durability check also fails", async () => {
    const actual = await vi.importActual<typeof import("../atomic-file")>("../atomic-file");
    vi.mocked(writeFileAtomically).mockImplementationOnce((file, contents) => {
      actual.writeFileAtomically(file, contents);
      vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
        throw new Error("fixture sync failure");
      });
      throw new Error("fixture after rename");
    });
    expect(() => updateReliabilityOperation(identity, () => undefined)).toThrow();
    vi.restoreAllMocks();
    expect(readReliabilityOperation(identity)?.revision).toBe(1);
  });

  it("rejects asynchronous updates and exhausted counters before persistence", () => {
    updateReliabilityOperation(identity, (record) => {
      record.revision = Number.MAX_SAFE_INTEGER - 1;
    });
    expect(() => updateReliabilityOperation(identity, () => undefined)).toThrow();
    const other = { ...identity, repoPath: path.join(identity.repoPath, "other") };
    expect(() => updateReliabilityOperation(other, async () => undefined)).toThrow();
    expect(readReliabilityOperation(other)).toBeUndefined();
  });
});

it("fences observation publication without changing manual state", () => {
  expect(() => withReliabilityObservationFence(identity, 0, () => undefined)).toThrow();
  updateReliabilityOperation(identity, () => undefined);
  const bytes = fs.readFileSync(reliabilityOperationPath(identity));
  const publish = vi.fn(() => "published");
  expect(withReliabilityObservationFence(identity, 1, publish)).toBe("published");
  expect(fs.readFileSync(reliabilityOperationPath(identity))).toEqual(bytes);
  updateReliabilityOperation(identity, () => undefined);
  expect(() => withReliabilityObservationFence(identity, 1, publish)).toThrow();
  expect(publish).toHaveBeenCalledTimes(1);
});
