import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVSY_AGENT_ASSETS,
  type DevsyAgentAsset,
  DevsyAgentReadinessError,
  devsyAgentManifestPath,
  devsyAgentRepairSuggestion,
  inspectDevsyAgent,
  isSupportedDevsyVersion,
  prepareDevsyAgent,
  requireReadyDevsyAgent,
} from "../devsy-agent";

let tmpDir: string;

function fixtureAsset(name: string, contents: Buffer): DevsyAgentAsset {
  return {
    githubAssetId: 1,
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
        githubAssetId: 529_830_010,
        size: 124_518_562,
        sha256: "31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d",
      }),
      expect.objectContaining({
        name: "devsy-linux-amd64",
        githubAssetId: 529_830_011,
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

  it("accepts the supported range and rejects everything outside it", () => {
    expect(isSupportedDevsyVersion("1.16.2")).toBe(true);
    expect(isSupportedDevsyVersion("1.19.0")).toBe(true);
    expect(isSupportedDevsyVersion("1.20.0-beta.1")).toBe(true);
    expect(isSupportedDevsyVersion("1.15.9")).toBe(false);
    expect(isSupportedDevsyVersion("1.16.2-beta.1")).toBe(false);
    expect(isSupportedDevsyVersion("2.0.0")).toBe(false);
    expect(isSupportedDevsyVersion("2.0.0-beta.1")).toBe(false);
    expect(isSupportedDevsyVersion(undefined)).toBe(false);

    for (const versionOutput of ["v1.15.9", "v2.0.0", "devsy v2.0.0-beta.1"]) {
      const inspection = inspectDevsyAgent({ versionOutput, env: {}, cacheRoot: tmpDir });
      expect(inspection.state).toBe("stale");
      expect(inspection.reason).toContain("outside the supported range");
    }
  });

  it("fails closed for older, prerelease, unparseable and unmapped versions", () => {
    expect(
      inspectDevsyAgent({ versionOutput: "v1.15.0", env: {}, cacheRoot: tmpDir }),
    ).toMatchObject({ state: "stale", installedVersion: "1.15.0" });
    expect(
      inspectDevsyAgent({ versionOutput: "devsy development build", env: {}, cacheRoot: tmpDir }),
    ).toMatchObject({ state: "stale" });
    expect(
      inspectDevsyAgent({
        versionOutput: "devsy v1.16.2-beta.1",
        platform: "darwin",
        arch: "arm64",
        env: {},
        cacheRoot: tmpDir,
      }),
    ).toMatchObject({ state: "stale", installedVersion: "1.16.2-beta.1" });
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

  it("accepts a newer host CLI without selecting a Devrouter agent", () => {
    const inspection = inspectDevsyAgent({
      versionOutput: "devsy v1.19.0",
      env: {},
      cacheRoot: tmpDir,
    });

    expect(inspection).toMatchObject({
      state: "ready",
      source: "host",
      installedVersion: "1.19.0",
      drift: { installed: "1.19.0", supported: "1.16.2" },
    });
    expect(inspection.binaryPath).toBeUndefined();
    expect(inspection.asset).toBeUndefined();
    expect(
      requireReadyDevsyAgent({ versionOutput: "v1.19.0", env: {}, cacheRoot: tmpDir }),
    ).toMatchObject({ source: "host", changed: false, transport: "existing" });
  });

  it("still validates an explicit agent under a newer host CLI", () => {
    const contents = Buffer.from("verified explicit agent");
    const asset = fixtureAsset("test-agent", contents);
    const binaryPath = path.join(tmpDir, "operator-agent");
    fs.writeFileSync(binaryPath, contents);
    const options = { ...baseOptions(asset), versionOutput: "devsy v1.19.0" };

    expect(
      inspectDevsyAgent({ ...options, env: { DEVSY_AGENT_BINARY: binaryPath } }),
    ).toMatchObject({ state: "ready", source: "explicit", binaryPath, asset });

    fs.writeFileSync(binaryPath, Buffer.from("substituted contents"));
    expect(
      inspectDevsyAgent({ ...options, env: { DEVSY_AGENT_BINARY: binaryPath } }),
    ).toMatchObject({ state: "invalid", source: "explicit" });
  });

  it.each([
    ["missing", "managed", "Run: devrouter setup --yes --workspace-runtime devsy"],
    [
      "stale",
      "explicit",
      "Install a supported Devsy release (>=1.16.2 <2.0.0) for a supported host, then run: devrouter setup --yes --workspace-runtime devsy",
    ],
    [
      "invalid",
      "explicit",
      "Fix or unset DEVSY_AGENT_BINARY, then run: devrouter setup --yes --workspace-runtime devsy",
    ],
  ] as const)("maps %s %s readiness to an effective repair", (state, source, expected) => {
    expect(devsyAgentRepairSuggestion({ state, source, reason: "fixture" })).toBe(expected);
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

    expect(result).toMatchObject({
      source: "managed",
      asset,
      changed: true,
      transport: "https",
    });
    const binaryPath = result.binaryPath ?? "";
    expect(fs.readFileSync(binaryPath)).toEqual(contents);
    expect(fs.statSync(binaryPath).mode & 0o777).toBe(0o700);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.dirname(binaryPath))).toEqual([asset.name]);
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
      transport: "existing",
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

  it("falls back to the pinned GitHub release asset when direct HTTPS cannot connect", async () => {
    const contents = Buffer.from("verified fallback agent");
    const asset = fixtureAsset("test-agent", contents);
    const fetcher = vi.fn(async () => {
      throw new Error("connect timeout");
    });
    const githubCliDownloader = vi.fn(async (_asset, writeChunk) => {
      await writeChunk(contents.subarray(0, 7));
      await writeChunk(contents.subarray(7));
    });

    const result = await prepareDevsyAgent({
      ...baseOptions(asset),
      fetcher,
      githubCliDownloader,
    });

    expect(result).toMatchObject({ changed: true, transport: "github-cli" });
    expect(githubCliDownloader).toHaveBeenCalledWith(asset, expect.any(Function));
    expect(fs.readFileSync(result.binaryPath ?? "")).toEqual(contents);
  });

  it("reports both acquisition transports when the GitHub CLI fallback fails", async () => {
    const contents = Buffer.from("verified fallback agent");
    const asset = fixtureAsset("test-agent", contents);

    await expect(
      prepareDevsyAgent({
        ...baseOptions(asset),
        fetcher: async () => {
          throw new Error("connect timeout");
        },
        githubCliDownloader: async () => {
          throw new Error("gh authentication unavailable");
        },
      }),
    ).rejects.toThrow(
      "direct HTTPS download failed: connect timeout; GitHub CLI fallback failed: gh authentication unavailable. Restore direct GitHub release access or install and authenticate gh.",
    );
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

describe("release-resolved Devsy agents", () => {
  const releaseVersion = "1.19.0";

  function metadataUrl(version: string): string {
    return `https://api.github.com/repos/devsy-org/devsy/releases/tags/v${version}`;
  }

  function releaseFetcher(
    contents: Buffer,
    overrides: { digest?: string; omitDigest?: boolean } = {},
  ): typeof fetch {
    const sha256 = overrides.digest ?? createHash("sha256").update(contents).digest("hex");
    return vi.fn(async (input: string | URL) => {
      if (String(input) === metadataUrl(releaseVersion)) {
        return Response.json({
          tag_name: `v${releaseVersion}`,
          assets: [
            {
              id: 7,
              name: "devsy-linux-arm64",
              size: contents.length,
              ...(overrides.omitDigest ? {} : { digest: `sha256:${sha256}` }),
              browser_download_url: `https://github.com/devsy-org/devsy/releases/download/v${releaseVersion}/devsy-linux-arm64`,
            },
          ],
        });
      }
      return response(contents);
    }) as unknown as typeof fetch;
  }

  function releaseOptions(fetcher: typeof fetch, version = releaseVersion) {
    return {
      versionOutput: `devsy v${version}`,
      platform: "darwin" as const,
      arch: "arm64",
      cacheRoot: tmpDir,
      lockPath: path.join(tmpDir, "agent.lock"),
      env: {},
      withLock: directLock,
      fetcher,
    };
  }

  it("resolves, verifies, and records the official agent for an in-range release", async () => {
    const contents = Buffer.from("official linux agent");
    const result = await prepareDevsyAgent(releaseOptions(releaseFetcher(contents)));

    expect(result).toMatchObject({
      version: releaseVersion,
      changed: true,
      transport: "https",
    });
    expect(result.binaryPath).toBe(path.join(tmpDir, `v${releaseVersion}`, "devsy-linux-arm64"));
    expect(fs.readFileSync(result.binaryPath ?? "")).toEqual(contents);
    expect(
      JSON.parse(fs.readFileSync(devsyAgentManifestPath(tmpDir, releaseVersion), "utf-8")),
    ).toMatchObject({
      version: 1,
      devsyVersion: releaseVersion,
      origin: "release",
      assets: [
        {
          githubAssetId: 7,
          name: "devsy-linux-arm64",
          size: contents.length,
          sha256: createHash("sha256").update(contents).digest("hex"),
        },
      ],
    });
  });

  it("reuses the recorded manifest without network access", async () => {
    const contents = Buffer.from("official linux agent");
    await prepareDevsyAgent(releaseOptions(releaseFetcher(contents)));

    const offlineFetcher = vi.fn(async () => {
      throw new Error("network is unavailable");
    }) as unknown as typeof fetch;
    expect(inspectDevsyAgent(releaseOptions(offlineFetcher))).toMatchObject({
      state: "ready",
      installedVersion: releaseVersion,
      manifestOrigin: "release",
    });

    const replayed = await prepareDevsyAgent(releaseOptions(offlineFetcher));
    expect(replayed).toMatchObject({ changed: false, transport: "existing" });
    expect(offlineFetcher).not.toHaveBeenCalled();
  });

  it("refuses a release whose published asset has no SHA-256 digest", async () => {
    const contents = Buffer.from("unverifiable agent");
    await expect(
      prepareDevsyAgent(releaseOptions(releaseFetcher(contents, { omitDigest: true }))),
    ).rejects.toThrow(/does not publish a SHA-256 digest/);
    expect(fs.existsSync(devsyAgentManifestPath(tmpDir, releaseVersion))).toBe(false);
  });

  it("refuses downloaded bytes that do not match the published digest", async () => {
    const contents = Buffer.from("expected agent bytes");
    await expect(
      prepareDevsyAgent(releaseOptions(releaseFetcher(contents, { digest: "a".repeat(64) }))),
    ).rejects.toThrow(/unexpected digest/);
    expect(fs.existsSync(path.join(tmpDir, `v${releaseVersion}`, "devsy-linux-arm64"))).toBe(false);
  });

  it("verifies an explicit override against the official manifest of an in-range release", async () => {
    const contents = Buffer.from("operator supplied agent");
    const binaryPath = path.join(tmpDir, "operator-agent");
    fs.writeFileSync(binaryPath, contents);

    const accepted = await prepareDevsyAgent({
      ...releaseOptions(releaseFetcher(contents)),
      env: { DEVSY_AGENT_BINARY: binaryPath },
    });
    expect(accepted).toMatchObject({ version: releaseVersion, source: "explicit", changed: false });
    expect(accepted.asset?.sha256).toBe(createHash("sha256").update(contents).digest("hex"));

    fs.writeFileSync(binaryPath, Buffer.from("substituted agent"));
    await expect(
      prepareDevsyAgent({
        ...releaseOptions(releaseFetcher(contents)),
        env: { DEVSY_AGENT_BINARY: binaryPath },
      }),
    ).rejects.toThrow(DevsyAgentReadinessError);
  });

  it("rejects an out-of-range release before any network access", async () => {
    const fetcher = vi.fn();
    await expect(
      prepareDevsyAgent(releaseOptions(fetcher as unknown as typeof fetch, "2.0.0")),
    ).rejects.toThrow(DevsyAgentReadinessError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
