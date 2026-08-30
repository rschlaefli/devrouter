import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVSY_AGENT_ASSETS,
  type DevsyAgentAsset,
  DevsyAgentReadinessError,
  inspectDevsyAgent,
  prepareDevsyAgent,
  requireReadyDevsyAgent,
} from "../devsy-agent";

let tmpDir: string;

function fixtureAsset(name: string, contents: Buffer): DevsyAgentAsset {
  return {
    name,
    size: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    url: `https://example.invalid/${name}`,
  };
}

async function directLock<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

function baseOptions(asset: DevsyAgentAsset) {
  return {
    versionOutput: "devsy v1.16.2",
    platform: "darwin" as const,
    arch: "arm64",
    cacheRoot: path.join(tmpDir, "cache"),
    lockPath: path.join(tmpDir, "agent.lock"),
    assets: [asset],
    nativeAssetName: asset.name,
    env: {},
    withLock: directLock,
  };
}

function response(contents: Buffer, status = 200): Response {
  return new Response(contents, { status });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devsy-agent-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Devsy agent manifest", () => {
  it("pins both official v1.16.2 Linux assets", () => {
    expect(DEVSY_AGENT_ASSETS).toEqual([
      expect.objectContaining({
        name: "devsy-linux-arm64",
        size: 124_518_562,
        sha256: "31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d",
      }),
      expect.objectContaining({
        name: "devsy-linux-amd64",
        size: 133_505_186,
        sha256: "4983c52a3536c5a91d1b5f356a1c3428778ebf3f896d9897f60bce3978abc839",
      }),
    ]);
  });

  it.each([
    ["arm64", "devsy-linux-arm64"],
    ["x64", "devsy-linux-amd64"],
  ])("maps darwin/%s to %s", (arch, expectedName) => {
    const inspection = inspectDevsyAgent({
      versionOutput: "v1.16.2",
      platform: "darwin",
      arch,
      cacheRoot: tmpDir,
      env: {},
    });

    expect(inspection).toMatchObject({
      state: "missing",
      source: "managed",
      asset: { name: expectedName },
    });
  });

  it("fails closed for unsupported versions and native mappings", () => {
    expect(
      inspectDevsyAgent({ versionOutput: "v1.17.0", env: {}, cacheRoot: tmpDir }),
    ).toMatchObject({ state: "stale", installedVersion: "1.17.0" });
    expect(
      inspectDevsyAgent({
        versionOutput: "v1.16.2",
        platform: "linux",
        arch: "arm64",
        env: {},
        cacheRoot: tmpDir,
      }),
    ).toMatchObject({ state: "stale" });
  });
});

describe("Devsy agent source inspection", () => {
  it("accepts an explicit readable regular file matching either pinned asset", () => {
    const contents = Buffer.from("verified explicit agent");
    const asset = fixtureAsset("test-agent", contents);
    const binaryPath = path.join(tmpDir, "operator-agent");
    fs.writeFileSync(binaryPath, contents);

    const inspection = inspectDevsyAgent({
      ...baseOptions(asset),
      env: { DEVSY_AGENT_BINARY: binaryPath },
    });

    expect(inspection).toMatchObject({
      state: "ready",
      source: "explicit",
      binaryPath,
      asset: { name: "test-agent" },
    });
  });

  it("rejects missing, substituted, and non-regular explicit sources", () => {
    const contents = Buffer.from("verified explicit agent");
    const asset = fixtureAsset("test-agent", contents);
    const binaryPath = path.join(tmpDir, "operator-agent");
    const options = baseOptions(asset);

    expect(
      inspectDevsyAgent({ ...options, env: { DEVSY_AGENT_BINARY: binaryPath } }),
    ).toMatchObject({ state: "invalid", source: "explicit" });

    fs.writeFileSync(binaryPath, Buffer.from("substituted contents"));
    expect(
      inspectDevsyAgent({ ...options, env: { DEVSY_AGENT_BINARY: binaryPath } }),
    ).toMatchObject({ state: "invalid", source: "explicit" });

    fs.rmSync(binaryPath);
    fs.mkdirSync(binaryPath);
    expect(
      inspectDevsyAgent({ ...options, env: { DEVSY_AGENT_BINARY: binaryPath } }),
    ).toMatchObject({ state: "invalid", source: "explicit" });
  });

  it("requires a ready source without exposing an unverified path", () => {
    const asset = fixtureAsset("test-agent", Buffer.from("agent"));
    const options = baseOptions(asset);

    expect(() => requireReadyDevsyAgent(options)).toThrow(DevsyAgentReadinessError);
    try {
      requireReadyDevsyAgent(options);
    } catch (error) {
      expect((error as Error).message).not.toContain(tmpDir);
    }
  });
});

describe("prepareDevsyAgent", () => {
  it("streams, verifies, chmods, and atomically publishes the native asset", async () => {
    const contents = Buffer.from("verified downloaded agent");
    const asset = fixtureAsset("test-agent", contents);
    const fetcher = vi.fn(async () => response(contents));

    const result = await prepareDevsyAgent({
      ...baseOptions(asset),
      fetcher,
    });

    expect(result).toMatchObject({ source: "managed", asset, changed: true });
    expect(fs.readFileSync(result.binaryPath)).toEqual(contents);
    expect(fs.statSync(result.binaryPath).mode & 0o777).toBe(0o700);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.dirname(result.binaryPath))).toEqual([asset.name]);
  });

  it("reuses an already verified managed source without network access", async () => {
    const contents = Buffer.from("already cached agent");
    const asset = fixtureAsset("test-agent", contents);
    const options = baseOptions(asset);
    const binaryPath = path.join(options.cacheRoot, "v1.16.2", asset.name);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, contents);
    const fetcher = vi.fn();

    await expect(prepareDevsyAgent({ ...options, fetcher })).resolves.toMatchObject({
      binaryPath,
      changed: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["truncated", Buffer.from("short")],
    ["substituted", Buffer.from("verified downloaded agenX")],
  ])("preserves an existing cache file after a %s download", async (_label, downloaded) => {
    const expected = Buffer.from("verified downloaded agent");
    const previous = Buffer.from("previous invalid cache");
    const asset = fixtureAsset("test-agent", expected);
    const options = baseOptions(asset);
    const binaryPath = path.join(options.cacheRoot, "v1.16.2", asset.name);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, previous);

    await expect(
      prepareDevsyAgent({ ...options, fetcher: async () => response(downloaded) }),
    ).rejects.toThrow(/unexpected (size|digest)/);

    expect(fs.readFileSync(binaryPath)).toEqual(previous);
    expect(fs.readdirSync(path.dirname(binaryPath))).toEqual([asset.name]);
  });

  it("rejects HTTP and interrupted responses without publishing a cache file", async () => {
    const contents = Buffer.from("verified downloaded agent");
    const asset = fixtureAsset("test-agent", contents);
    const options = baseOptions(asset);
    const binaryPath = path.join(options.cacheRoot, "v1.16.2", asset.name);

    await expect(
      prepareDevsyAgent({ ...options, fetcher: async () => response(Buffer.alloc(0), 503) }),
    ).rejects.toThrow("HTTP 503");
    expect(fs.existsSync(binaryPath)).toBe(false);

    const interrupted = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(contents.subarray(0, 4));
          controller.error(new Error("connection interrupted"));
        },
      }),
    );
    await expect(
      prepareDevsyAgent({ ...options, fetcher: async () => interrupted }),
    ).rejects.toThrow("connection interrupted");
    expect(fs.existsSync(binaryPath)).toBe(false);
    if (fs.existsSync(path.dirname(binaryPath))) {
      expect(fs.readdirSync(path.dirname(binaryPath))).toEqual([]);
    }
  });

  it("does not replace or download for an invalid explicit override", async () => {
    const contents = Buffer.from("verified agent");
    const asset = fixtureAsset("test-agent", contents);
    const binaryPath = path.join(tmpDir, "operator-agent");
    fs.writeFileSync(binaryPath, Buffer.from("invalid"));
    const fetcher = vi.fn();

    await expect(
      prepareDevsyAgent({
        ...baseOptions(asset),
        env: { DEVSY_AGENT_BINARY: binaryPath },
        fetcher,
      }),
    ).rejects.toThrow(DevsyAgentReadinessError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fs.readFileSync(binaryPath, "utf-8")).toBe("invalid");
  });

  it("rechecks inside the cache lock so concurrent preparation downloads once", async () => {
    const contents = Buffer.from("verified concurrent agent");
    const asset = fixtureAsset("test-agent", contents);
    let releaseDownload: (() => void) | undefined;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    let downloadStarted: (() => void) | undefined;
    const downloadStartedPromise = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const fetcher = vi.fn(async () => {
      downloadStarted?.();
      await downloadGate;
      return response(contents);
    });
    let queue = Promise.resolve();
    const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = queue;
      let release: (() => void) | undefined;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release?.();
      }
    };
    const options = { ...baseOptions(asset), fetcher, withLock };

    const first = prepareDevsyAgent(options);
    await downloadStartedPromise;
    const second = prepareDevsyAgent(options);
    releaseDownload?.();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.changed)).toEqual([true, false]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
