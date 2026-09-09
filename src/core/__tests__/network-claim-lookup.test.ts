import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOwnedNetworkClaim, networkOwnerKey } from "../network-claim-lookup";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function fixture(daemonId = "synthetic-daemon") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claim-lookup-"));
  roots.push(root);
  const claim = {
    ownerKey: networkOwnerKey("/synthetic"),
    providerId: "synthetic",
    provider: "devsy",
    providerContext: "default",
    definitionSha256: "a".repeat(64),
    endpoint: "unix:///synthetic.sock",
    daemonId,
    configFingerprint: "fingerprint",
    subnet: "10.88.0.0/26",
    prefix: 26,
    operationId: "operation",
    fence: {
      environmentId: "environment",
      intentRevision: 1,
      runtimeGeneration: 1,
      controllerEpoch: 1,
    },
    workerId: "worker",
    state: "reserved",
  };
  const file = path.join(root, `${createHash("sha256").update(daemonId).digest("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, daemonId, claims: [claim] }), {
    mode: 0o600,
  });
  return { root, file, claim };
}
describe("retained claim lookup across daemon policy changes", () => {
  it("finds the saved daemon by opaque owner and never adopts another owner", () => {
    const f = fixture();
    expect(findOwnedNetworkClaim("/synthetic", f.root)).toEqual(f.claim);
    expect(findOwnedNetworkClaim("/other", f.root)).toBeUndefined();
  });
  it("fails closed for duplicate owners and malformed state without leaking content", () => {
    const first = fixture();
    const second = fixture("other-daemon");
    fs.copyFileSync(second.file, path.join(first.root, path.basename(second.file)));
    expect(() => findOwnedNetworkClaim("/synthetic", first.root)).toThrow();
    fs.writeFileSync(first.file, "synthetic-sensitive-marker");
    try {
      findOwnedNetworkClaim("/synthetic", first.root);
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-sensitive-marker");
    }
  });
});
