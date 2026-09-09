import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK_POLICY_ENDPOINT_RESERVE,
  MAX_NETWORK_POLICY_ARRAY_ENTRIES,
  MAX_NETWORK_POLICY_DAEMON_ID_LENGTH,
  MAX_NETWORK_POLICY_FILE_BYTES,
  type NetworkPolicy,
  parseNetworkPolicy,
  readNetworkPolicy,
} from "../network-policy";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function policy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
  return {
    version: 1,
    daemonId: "synthetic-daemon",
    pools: ["10.88.0.0/16"],
    exclusions: ["10.88.0.0/24"],
    allowedPrefixes: [26],
    endpointReserve: DEFAULT_NETWORK_POLICY_ENDPOINT_RESERVE,
    ...overrides,
  };
}

function writePolicy(value: unknown): string {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-network-policy-"));
  const filePath = path.join(temporaryDirectory, "network-policy.json");
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

describe("parseNetworkPolicy", () => {
  it("accepts an explicit private policy and defaults the endpoint reserve", () => {
    const value = policy();
    delete (value as Partial<NetworkPolicy>).endpointReserve;

    expect(parseNetworkPolicy(value)).toEqual({
      ...policy(),
      endpointReserve: DEFAULT_NETWORK_POLICY_ENDPOINT_RESERVE,
    });
  });

  it.each([24, 25, 26] as const)("bounds pools at 4096 candidates for /%s", (prefix) => {
    const minimum = prefix - 12;
    expect(
      parseNetworkPolicy(
        policy({ pools: [`10.0.0.0/${minimum}`], exclusions: [], allowedPrefixes: [prefix] }),
      ).pools,
    ).toHaveLength(1);
    expect(() =>
      parseNetworkPolicy(
        policy({ pools: [`10.0.0.0/${minimum - 1}`], exclusions: [], allowedPrefixes: [prefix] }),
      ),
    ).toThrow();
  });

  it("allows an explicit empty exclusions array", () => {
    expect(parseNetworkPolicy({ ...policy(), exclusions: [] }).exclusions).toEqual([]);
    const withoutExclusions = { ...policy() };
    delete (withoutExclusions as Partial<NetworkPolicy>).exclusions;
    expect(() => parseNetworkPolicy(withoutExclusions)).toThrow();
  });

  it("requires an explicit pool and rejects unsupported keys", () => {
    expect(() => parseNetworkPolicy({ ...policy(), pools: undefined })).toThrow();
    expect(() => parseNetworkPolicy({ ...policy(), implicitPool: "10.89.0.0/16" })).toThrow();
  });

  it.each([
    ["overlapping pools", { pools: ["10.88.0.0/16", "10.88.1.0/24"] }],
    ["overlapping exclusions", { exclusions: ["10.88.0.0/24", "10.88.0.0/25"] }],
    ["an exclusion outside the pools", { exclusions: ["10.89.0.0/24"] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseNetworkPolicy({ ...policy(), ...overrides })).toThrow();
  });

  it.each([
    ["a public range", { pools: ["192.0.2.0/24"] }],
    ["a host-bit CIDR", { pools: ["10.88.0.1/24"] }],
    ["the universal subnet", { pools: ["0.0.0.0/0"] }],
    ["an IPv6 range", { pools: ["fd00::/8"] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseNetworkPolicy({ ...policy(), ...overrides })).toThrow();
  });

  it("accepts only distinct allocation prefixes 24, 25, and 26", () => {
    for (const allowedPrefixes of [[24], [25], [26], [24, 25, 26]]) {
      expect(parseNetworkPolicy({ ...policy(), allowedPrefixes }).allowedPrefixes).toEqual(
        allowedPrefixes,
      );
    }
    expect(() => parseNetworkPolicy({ ...policy(), allowedPrefixes: [23] })).toThrow();
    expect(() => parseNetworkPolicy({ ...policy(), allowedPrefixes: [26, 26] })).toThrow();
  });

  it("bounds policy strings and arrays", () => {
    expect(() =>
      parseNetworkPolicy({
        ...policy(),
        daemonId: "d".repeat(MAX_NETWORK_POLICY_DAEMON_ID_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      parseNetworkPolicy({
        ...policy(),
        pools: Array.from({ length: MAX_NETWORK_POLICY_ARRAY_ENTRIES + 1 }, () => "10.88.0.0/24"),
      }),
    ).toThrow();
    expect(() =>
      parseNetworkPolicy({
        ...policy(),
        exclusions: Array.from(
          { length: MAX_NETWORK_POLICY_ARRAY_ENTRIES + 1 },
          () => "10.88.0.0/32",
        ),
      }),
    ).toThrow();
  });

  it("keeps validation errors free of policy values", () => {
    const secretDaemonId = "synthetic-daemon-value-that-must-not-escape";
    const secretCidr = "10.88.7.0/24";
    let error: unknown;
    try {
      parseNetworkPolicy({
        ...policy({ daemonId: secretDaemonId, pools: [secretCidr], exclusions: [secretCidr] }),
        unknown: secretDaemonId,
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).not.toContain(secretDaemonId);
    expect(String(error)).not.toContain(secretCidr);
  });
});

describe("readNetworkPolicy", () => {
  it("distinguishes an absent policy from an invalid policy", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-network-policy-"));
    const absentPath = path.join(temporaryDirectory, "absent.json");
    expect(readNetworkPolicy(absentPath)).toMatchObject({ status: "absent", path: absentPath });

    const invalidPath = path.join(temporaryDirectory, "invalid.json");
    fs.writeFileSync(invalidPath, JSON.stringify({ ...policy(), pools: ["10.88.0.1/24"] }), "utf8");
    expect(readNetworkPolicy(invalidPath)).toMatchObject({ status: "invalid", path: invalidPath });
  });

  it("returns a validated policy for an explicit caller path", () => {
    const filePath = writePolicy({ ...policy(), endpointReserve: undefined });
    const result = readNetworkPolicy(filePath);

    expect(result).toEqual({
      status: "valid",
      path: filePath,
      policy: policy(),
    });
  });

  it("does not expose malformed JSON or validation values", () => {
    const invalidJsonPath = writePolicy({});
    fs.writeFileSync(invalidJsonPath, "{", "utf8");
    const invalidJson = readNetworkPolicy(invalidJsonPath);
    expect(invalidJson).toMatchObject({
      status: "invalid",
      error: "network policy JSON is invalid",
    });

    const secret = "synthetic-policy-secret";
    const schemaPath = writePolicy({ ...policy(), daemonId: secret, extra: secret });
    const schema = readNetworkPolicy(schemaPath);
    expect(schema.status).toBe("invalid");
    expect(JSON.stringify(schema)).not.toContain(secret);
  });

  it("rejects an oversized policy file before JSON parsing", () => {
    const filePath = writePolicy({});
    fs.writeFileSync(filePath, "x".repeat(MAX_NETWORK_POLICY_FILE_BYTES + 1), "utf8");

    expect(readNetworkPolicy(filePath)).toEqual({
      status: "invalid",
      path: filePath,
      error: "network policy exceeds the file size limit",
    });
  });

  it("rejects a directory instead of treating it as a policy file", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-network-policy-"));
    expect(readNetworkPolicy(temporaryDirectory)).toMatchObject({
      status: "invalid",
      error: "network policy must be a regular file",
    });
  });
});
