import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createStderrWaitReporter, withFileLock } from "./file-lock";
import { CACHE_DIR, DEVROUTER_HOME } from "./router";

export const SUPPORTED_DEVSY_VERSION = "1.16.2";
export const DEVSY_AGENT_SETUP_COMMAND = "devrouter setup --yes --workspace-runtime devsy";

export type DevsyAgentAsset = {
  githubAssetId: number;
  name: string;
  size: number;
  sha256: string;
  url: string;
};

export const DEVSY_AGENT_ASSETS: readonly DevsyAgentAsset[] = [
  {
    githubAssetId: 529_830_010,
    name: "devsy-linux-arm64",
    size: 124_518_562,
    sha256: "31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d",
    url: "https://github.com/devsy-org/devsy/releases/download/v1.16.2/devsy-linux-arm64",
  },
  {
    githubAssetId: 529_830_011,
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
  transport: "existing" | "https" | "github-cli";
};

type DevsyAgentChunkWriter = (chunk: Uint8Array) => Promise<void>;
type GitHubCliDownloader = (
  asset: DevsyAgentAsset,
  writeChunk: DevsyAgentChunkWriter,
) => Promise<void>;

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
  githubCliDownloader?: GitHubCliDownloader;
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
  return output?.match(
    /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\b/,
  )?.[1];
}

export function devsyAgentRepairSuggestion(inspection: DevsyAgentInspection): string {
  if (inspection.state === "stale") {
    return `Install Devsy ${SUPPORTED_DEVSY_VERSION} for a supported host, then run: ${DEVSY_AGENT_SETUP_COMMAND}`;
  }
  return inspection.source === "explicit"
    ? `Fix or unset DEVSY_AGENT_BINARY, then run: ${DEVSY_AGENT_SETUP_COMMAND}`
    : `Run: ${DEVSY_AGENT_SETUP_COMMAND}`;
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

const GITHUB_CLI_STDERR_TAIL_BYTES = 4096;

function appendBoundedTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= GITHUB_CLI_STDERR_TAIL_BYTES) {
    return Buffer.from(chunk.subarray(chunk.length - GITHUB_CLI_STDERR_TAIL_BYTES));
  }
  const combined = Buffer.concat([current, chunk]);
  return combined.length > GITHUB_CLI_STDERR_TAIL_BYTES
    ? combined.subarray(combined.length - GITHUB_CLI_STDERR_TAIL_BYTES)
    : combined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function downloadWithGitHubCli(
  asset: DevsyAgentAsset,
  writeChunk: DevsyAgentChunkWriter,
): Promise<void> {
  const child = spawn(
    "gh",
    [
      "api",
      `repos/devsy-org/devsy/releases/assets/${asset.githubAssetId}`,
      "-H",
      "Accept: application/octet-stream",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!child.stdout || !child.stderr) {
    child.kill();
    throw new Error("GitHub CLI fallback did not create output pipes");
  }

  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrTail = appendBoundedTail(stderrTail, value);
  });
  let spawnError: Error | undefined;
  const completion = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status) => {
      resolve(status);
    });
  });

  try {
    for await (const chunk of child.stdout) {
      await writeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const status = await completion;
    if (spawnError) throw spawnError;
    if (status !== 0) {
      const details = stderrTail.toString("utf-8").trim();
      throw new Error(
        `gh api exited with status ${status ?? "unknown"}${details ? `: ${details}` : ""}`,
      );
    }
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await completion.catch(() => undefined);
    throw error;
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
  githubCliDownloader: GitHubCliDownloader,
): Promise<"https" | "github-cli"> {
  const directory = path.dirname(binaryPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(binaryPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    let response: Response | undefined;
    let directFailure: unknown;
    try {
      response = await fetcher(asset.url);
    } catch (error) {
      directFailure = error;
    }

    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    const digest = createHash("sha256");
    let size = 0;
    const writeChunk = async (chunk: Uint8Array): Promise<void> => {
      size += chunk.byteLength;
      if (size > asset.size) {
        throw new Error("Devsy agent download exceeded the pinned size");
      }
      digest.update(chunk);
      await writeAll(handle as FileHandle, chunk, size - chunk.byteLength);
    };
    let transport: "https" | "github-cli";
    if (response) {
      if (!response.ok) {
        throw new Error(`Devsy agent download failed with HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Devsy agent download returned no response body");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeChunk(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      transport = "https";
    } else {
      try {
        await githubCliDownloader(asset, writeChunk);
      } catch (fallbackError) {
        throw new Error(
          `Devsy agent direct HTTPS download failed: ${errorMessage(directFailure)}; GitHub CLI fallback failed: ${errorMessage(fallbackError)}. Restore direct GitHub release access or install and authenticate gh.`,
        );
      }
      transport = "github-cli";
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
    return transport;
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
      transport: "existing",
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
        transport: "existing",
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

    const transport = await downloadAndPublish(
      current.asset,
      current.binaryPath,
      options.fetcher ?? fetch,
      options.githubCliDownloader ?? downloadWithGitHubCli,
    );
    const published = inspectDevsyAgent(inspectOptions);
    if (published.state !== "ready" || !published.binaryPath || !published.asset) {
      throw new DevsyAgentReadinessError(published);
    }
    return {
      binaryPath: published.binaryPath,
      source: published.source,
      asset: published.asset,
      changed: true,
      transport,
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
    transport: "existing",
  };
}
