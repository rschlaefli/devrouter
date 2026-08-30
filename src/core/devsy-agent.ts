import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createStderrWaitReporter, withFileLock } from "./file-lock";
import { CACHE_DIR, DEVROUTER_HOME } from "./router";

export const SUPPORTED_DEVSY_VERSION = "1.16.2";
export const DEVSY_AGENT_SETUP_COMMAND = "devrouter setup --yes --workspace-runtime devsy";

export type DevsyAgentAsset = {
  name: string;
  size: number;
  sha256: string;
  url: string;
};

export const DEVSY_AGENT_ASSETS: readonly DevsyAgentAsset[] = [
  {
    name: "devsy-linux-arm64",
    size: 124_518_562,
    sha256: "31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d",
    url: "https://github.com/devsy-org/devsy/releases/download/v1.16.2/devsy-linux-arm64",
  },
  {
    name: "devsy-linux-amd64",
    size: 133_505_186,
    sha256: "4983c52a3536c5a91d1b5f356a1c3428778ebf3f896d9897f60bce3978abc839",
    url: "https://github.com/devsy-org/devsy/releases/download/v1.16.2/devsy-linux-amd64",
  },
] as const;

export type DevsyAgentState = "ready" | "missing" | "stale" | "invalid";
export type DevsyAgentSource = "explicit" | "managed";

export type DevsyAgentInspection = {
  state: DevsyAgentState;
  source: DevsyAgentSource;
  reason: string;
  binaryPath?: string;
  asset?: DevsyAgentAsset;
  installedVersion?: string;
};

export type PreparedDevsyAgent = {
  binaryPath: string;
  source: DevsyAgentSource;
  asset: DevsyAgentAsset;
  changed: boolean;
};

type DevsyAgentOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  versionOutput?: string;
  cacheRoot?: string;
  lockPath?: string;
  assets?: readonly DevsyAgentAsset[];
  nativeAssetName?: string;
};

type PrepareDevsyAgentOptions = DevsyAgentOptions & {
  fetcher?: typeof fetch;
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export class DevsyAgentReadinessError extends Error {
  constructor(readonly inspection: DevsyAgentInspection) {
    super(`Devsy agent is ${inspection.state}: ${inspection.reason}`);
    this.name = "DevsyAgentReadinessError";
  }
}

const DEVSY_AGENT_CACHE_LOCK = path.join(DEVROUTER_HOME, "devsy-agent-cache.lock");
const DEVSY_AGENT_LOCK_WAIT_MS = 1_800_000;

function parseVersion(output: string | undefined): string | undefined {
  return output?.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];
}

function installedVersionOutput(): string | undefined {
  const result = spawnSync("devsy", ["--version"], { encoding: "utf-8" });
  if (result.error || result.status !== 0) return undefined;
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || undefined;
}

function nativeAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return "devsy-linux-arm64";
  if (arch === "x64") return "devsy-linux-amd64";
  return undefined;
}

function managedBinaryPath(cacheRoot: string, asset: DevsyAgentAsset): string {
  return path.join(cacheRoot, `v${SUPPORTED_DEVSY_VERSION}`, asset.name);
}

function hashOpenFile(file: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const bytesRead = fs.readSync(file, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

function inspectBinary(
  binaryPath: string,
  assets: readonly DevsyAgentAsset[],
  missingState: DevsyAgentState,
): Pick<DevsyAgentInspection, "state" | "reason" | "asset"> {
  let file: number | undefined;
  try {
    file = fs.openSync(binaryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(file);
    if (!stat.isFile()) {
      return { state: "invalid", reason: "the selected source is not a regular file" };
    }
    const sizeMatches = assets.filter((asset) => asset.size === stat.size);
    if (sizeMatches.length === 0) {
      return { state: "invalid", reason: "the selected source has an unexpected size" };
    }
    const sha256 = hashOpenFile(file);
    const asset = sizeMatches.find((candidate) => candidate.sha256 === sha256);
    return asset
      ? { state: "ready", reason: "the selected source matches the pinned manifest", asset }
      : { state: "invalid", reason: "the selected source has an unexpected digest" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { state: missingState, reason: "the selected source is missing" }
      : { state: "invalid", reason: "the selected source is not a readable regular file" };
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
}

function resolvedOptions(
  options: DevsyAgentOptions,
): Required<
  Pick<DevsyAgentOptions, "env" | "platform" | "arch" | "cacheRoot" | "lockPath" | "assets">
> &
  Pick<DevsyAgentOptions, "versionOutput" | "nativeAssetName"> {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    versionOutput: options.versionOutput ?? installedVersionOutput(),
    cacheRoot: options.cacheRoot ?? path.join(CACHE_DIR, "devsy", "agents"),
    lockPath: options.lockPath ?? DEVSY_AGENT_CACHE_LOCK,
    assets: options.assets ?? DEVSY_AGENT_ASSETS,
    nativeAssetName: options.nativeAssetName,
  };
}

export function inspectDevsyAgent(options: DevsyAgentOptions = {}): DevsyAgentInspection {
  const resolved = resolvedOptions(options);
  const installedVersion = parseVersion(resolved.versionOutput);
  const explicitPath = resolved.env.DEVSY_AGENT_BINARY?.trim();
  const source: DevsyAgentSource = explicitPath ? "explicit" : "managed";

  if (installedVersion !== SUPPORTED_DEVSY_VERSION) {
    return {
      state: "stale",
      source,
      reason: installedVersion
        ? `installed Devsy ${installedVersion} is not supported by this Devrouter release`
        : "the supported Devsy version is not available",
      installedVersion,
    };
  }

  if (explicitPath) {
    return {
      ...inspectBinary(explicitPath, resolved.assets, "invalid"),
      source,
      binaryPath: explicitPath,
      installedVersion,
    };
  }

  const expectedName =
    resolved.nativeAssetName ?? nativeAssetName(resolved.platform, resolved.arch);
  const asset = resolved.assets.find((candidate) => candidate.name === expectedName);
  if (!asset) {
    return {
      state: "stale",
      source,
      reason: `this Devrouter release has no pinned Devsy agent for ${resolved.platform}/${resolved.arch}`,
      installedVersion,
    };
  }
  const binaryPath = managedBinaryPath(resolved.cacheRoot, asset);
  return {
    ...inspectBinary(binaryPath, [asset], "missing"),
    source,
    binaryPath,
    asset,
    installedVersion,
  };
}

async function writeAll(handle: FileHandle, chunk: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error("Devsy agent download stopped making progress");
    offset += bytesWritten;
  }
}

function fsyncDirectory(directory: string): void {
  const handle = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

async function downloadAndPublish(
  asset: DevsyAgentAsset,
  binaryPath: string,
  fetcher: typeof fetch,
): Promise<void> {
  const directory = path.dirname(binaryPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(binaryPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    const response = await fetcher(asset.url);
    if (!response.ok) {
      throw new Error(`Devsy agent download failed with HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Devsy agent download returned no response body");

    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.size) {
        await reader.cancel();
        throw new Error("Devsy agent download exceeded the pinned size");
      }
      digest.update(value);
      await writeAll(handle, value, size - value.byteLength);
    }
    if (size !== asset.size) throw new Error("Devsy agent download has an unexpected size");
    if (digest.digest("hex") !== asset.sha256) {
      throw new Error("Devsy agent download has an unexpected digest");
    }

    await handle.sync();
    await handle.chmod(0o700);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, binaryPath);
    fsyncDirectory(directory);
  } finally {
    if (handle) await handle.close();
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

export async function prepareDevsyAgent(
  options: PrepareDevsyAgentOptions = {},
): Promise<PreparedDevsyAgent> {
  const resolved = resolvedOptions(options);
  const inspectOptions: DevsyAgentOptions = resolved;
  const before = inspectDevsyAgent(inspectOptions);
  if (before.state === "ready" && before.binaryPath && before.asset) {
    return {
      binaryPath: before.binaryPath,
      source: before.source,
      asset: before.asset,
      changed: false,
    };
  }
  if (
    before.source === "explicit" ||
    before.state === "stale" ||
    !before.binaryPath ||
    !before.asset
  ) {
    throw new DevsyAgentReadinessError(before);
  }

  const lock =
    options.withLock ??
    (<T>(operation: () => Promise<T>) => {
      fs.mkdirSync(path.dirname(resolved.lockPath), { recursive: true });
      return withFileLock(
        resolved.lockPath,
        {
          activity: "Devsy agent acquisition",
          waitMs: DEVSY_AGENT_LOCK_WAIT_MS,
          fair: true,
          onWait: createStderrWaitReporter("Devsy agent acquisition", "the managed cache"),
        },
        operation,
      );
    });

  return lock(async () => {
    const current = inspectDevsyAgent(inspectOptions);
    if (current.state === "ready" && current.binaryPath && current.asset) {
      return {
        binaryPath: current.binaryPath,
        source: current.source,
        asset: current.asset,
        changed: false,
      };
    }
    if (
      current.source === "explicit" ||
      current.state === "stale" ||
      !current.binaryPath ||
      !current.asset
    ) {
      throw new DevsyAgentReadinessError(current);
    }

    await downloadAndPublish(current.asset, current.binaryPath, options.fetcher ?? fetch);
    const published = inspectDevsyAgent(inspectOptions);
    if (published.state !== "ready" || !published.binaryPath || !published.asset) {
      throw new DevsyAgentReadinessError(published);
    }
    return {
      binaryPath: published.binaryPath,
      source: published.source,
      asset: published.asset,
      changed: true,
    };
  });
}

export function requireReadyDevsyAgent(options: DevsyAgentOptions = {}): PreparedDevsyAgent {
  const inspection = inspectDevsyAgent(options);
  if (inspection.state !== "ready" || !inspection.binaryPath || !inspection.asset) {
    throw new DevsyAgentReadinessError(inspection);
  }
  return {
    binaryPath: inspection.binaryPath,
    source: inspection.source,
    asset: inspection.asset,
    changed: false,
  };
}
