import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createStderrWaitReporter, withFileLock } from "./file-lock";
import { CACHE_DIR, DEVROUTER_HOME } from "./router";

/**
 * Devrouter injects the official Devsy Linux agent instead of letting a cold
 * start discover it. The committed manifest pins the release whose assets were
 * reviewed in this repository; other official releases inside the supported
 * range are resolved from their published release metadata and verified
 * against the SHA-256 digest GitHub reports for that asset.
 */
export const PINNED_DEVSY_AGENT_VERSION = "1.16.2";
export const SUPPORTED_DEVSY_MIN_VERSION = "1.16.2";
export const SUPPORTED_DEVSY_MAX_VERSION = "2.0.0";
export const SUPPORTED_DEVSY_RANGE = `>=${SUPPORTED_DEVSY_MIN_VERSION} <${SUPPORTED_DEVSY_MAX_VERSION}`;
export const DEVSY_AGENT_SETUP_COMMAND = "devrouter setup --yes --workspace-runtime devsy";
export const DEVSY_RELEASE_TAG_PREFIX = "v";
export const DEVSY_RELEASE_METADATA_BASE_URL =
  "https://api.github.com/repos/devsy-org/devsy/releases/tags";

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
/**
 * Where the agent binary comes from. `managed` is the Devrouter-verified cache
 * entry for the pinned CLI, `explicit` is an operator-supplied path, and `host`
 * means a newer host CLI governs its own agent with nothing injected.
 */
export type DevsyAgentSource = "explicit" | "managed" | "host";

/** A host CLI newer than the verified pin, together with the pin. */
export type DevsyAgentDrift = { installed: string; supported: string };
export type DevsyAgentManifestOrigin = "pinned" | "release";

export type DevsyAgentInspection = {
  state: DevsyAgentState;
  source: DevsyAgentSource;
  reason: string;
  binaryPath?: string;
  asset?: DevsyAgentAsset;
  installedVersion?: string;
  drift?: DevsyAgentDrift;
  manifestOrigin?: DevsyAgentManifestOrigin;
};

export type DevsyAgentManifest = {
  version: string;
  origin: DevsyAgentManifestOrigin;
  assets: readonly DevsyAgentAsset[];
};

export type PreparedDevsyAgent = {
  version: string;
  binaryPath?: string;
  source: DevsyAgentSource;
  asset?: DevsyAgentAsset;
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

type DevsySemver = { major: number; minor: number; patch: number; prerelease: string[] };

function parseSemver(value: string): DevsySemver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemver(left: DevsySemver, right: DevsySemver): number {
  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * A release inside `SUPPORTED_DEVSY_RANGE`. Prereleases count as supported when
 * their version triple stays below the ceiling, so a stable Devsy bump never
 * needs a Devrouter release while a next-major prerelease stays blocked.
 */
export function isSupportedDevsyVersion(version: string | undefined): boolean {
  const parsed = version === undefined ? undefined : parseSemver(version);
  const minimum = parseSemver(SUPPORTED_DEVSY_MIN_VERSION);
  const maximum = parseSemver(SUPPORTED_DEVSY_MAX_VERSION);
  if (!parsed || !minimum || !maximum) return false;
  if (compareSemver(parsed, minimum) < 0) return false;
  if (
    parsed.prerelease.length > 0 &&
    parsed.major === maximum.major &&
    parsed.minor === maximum.minor &&
    parsed.patch === maximum.patch
  ) {
    return false;
  }
  return compareSemver(parsed, maximum) < 0;
}

type DevsyAgentManifestRecord = {
  version: 1;
  devsyVersion: string;
  origin: "release";
  resolvedAt: string;
  assets: DevsyAgentAsset[];
};

const DEVSY_AGENT_MANIFEST_FILE = "manifest.json";
const DEVSY_AGENT_ASSET_NAMES = ["devsy-linux-arm64", "devsy-linux-amd64"] as const;

function isDevsyAgentAsset(value: unknown): value is DevsyAgentAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.githubAssetId === "number" &&
    Number.isSafeInteger(asset.githubAssetId) &&
    typeof asset.name === "string" &&
    typeof asset.size === "number" &&
    Number.isSafeInteger(asset.size) &&
    asset.size > 0 &&
    typeof asset.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(asset.sha256) &&
    typeof asset.url === "string" &&
    asset.url.startsWith("https://")
  );
}

/** Machine-local verified manifest for one resolved Devsy release. */
export function devsyAgentManifestPath(cacheRoot: string, devsyVersion: string): string {
  return path.join(cacheRoot, `v${devsyVersion}`, DEVSY_AGENT_MANIFEST_FILE);
}

function readManifestRecord(
  cacheRoot: string,
  devsyVersion: string,
): DevsyAgentManifest | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(devsyAgentManifestPath(cacheRoot, devsyVersion), "utf-8"),
    ) as Partial<DevsyAgentManifestRecord>;
    if (parsed.version !== 1 || parsed.devsyVersion !== devsyVersion) return undefined;
    if (parsed.origin !== "release") return undefined;
    if (!Array.isArray(parsed.assets) || parsed.assets.length === 0) return undefined;
    if (!parsed.assets.every(isDevsyAgentAsset)) return undefined;
    return { version: devsyVersion, origin: "release", assets: parsed.assets };
  } catch {
    return undefined;
  }
}

function writeManifestRecord(cacheRoot: string, manifest: DevsyAgentManifest): void {
  const target = devsyAgentManifestPath(cacheRoot, manifest.version);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${DEVSY_AGENT_MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  const record: DevsyAgentManifestRecord = {
    version: 1,
    devsyVersion: manifest.version,
    origin: "release",
    resolvedAt: new Date().toISOString(),
    assets: [...manifest.assets],
  };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function pinnedManifest(version: string): DevsyAgentManifest | undefined {
  return version === PINNED_DEVSY_AGENT_VERSION
    ? { version, origin: "pinned", assets: DEVSY_AGENT_ASSETS }
    : undefined;
}

function manifestForVersion(
  resolved: ReturnType<typeof resolvedOptions>,
  version: string,
): DevsyAgentManifest | undefined {
  if (resolved.assets) return { version, origin: "pinned", assets: resolved.assets };
  return pinnedManifest(version) ?? readManifestRecord(resolved.cacheRoot, version);
}

/**
 * Reads the release metadata GitHub publishes for one Devsy tag and keeps only
 * the official Linux agent assets whose SHA-256 digest it reports. A release
 * without a verifiable digest is refused instead of trusted.
 */
export async function resolveReleaseDevsyAgentManifest(
  version: string,
  fetcher: typeof fetch,
): Promise<DevsyAgentManifest> {
  const url = `${DEVSY_RELEASE_METADATA_BASE_URL}/${DEVSY_RELEASE_TAG_PREFIX}${version}`;
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/vnd.github+json" } });
  } catch (error) {
    throw new Error(`Devsy ${version} release metadata could not be read: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Devsy ${version} release metadata is unavailable (HTTP ${response.status}).`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Devsy ${version} release metadata is not valid JSON: ${errorMessage(error)}`);
  }
  const release = payload as { tag_name?: unknown; assets?: unknown };
  if (release?.tag_name !== `${DEVSY_RELEASE_TAG_PREFIX}${version}`) {
    throw new Error(`Devsy ${version} release metadata reported an unexpected tag.`);
  }
  if (!Array.isArray(release.assets)) {
    throw new Error(`Devsy ${version} release metadata reported no assets.`);
  }

  const assets: DevsyAgentAsset[] = [];
  for (const entry of release.assets) {
    const candidate = (entry ?? {}) as Record<string, unknown>;
    const name = candidate.name;
    if (
      typeof name !== "string" ||
      !DEVSY_AGENT_ASSET_NAMES.some((assetName) => assetName === name)
    )
      continue;
    const id = candidate.id;
    const size = candidate.size;
    const digest = candidate.digest;
    const downloadUrl = candidate.browser_download_url;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size <= 0
    ) {
      throw new Error(`Devsy ${version} reported an unusable ${String(name)} asset.`);
    }
    const sha256 =
      typeof digest === "string" && digest.startsWith("sha256:")
        ? digest.slice("sha256:".length).toLowerCase()
        : "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(
        `Devsy ${version} does not publish a SHA-256 digest for ${String(name)}; Devrouter cannot verify this release.`,
      );
    }
    if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("https://")) {
      throw new Error(`Devsy ${version} reported an unusable ${String(name)} download URL.`);
    }
    assets.push({ githubAssetId: id, name, size, sha256, url: downloadUrl });
  }
  if (assets.length === 0) {
    throw new Error(`Devsy ${version} publishes no official Linux agent asset.`);
  }
  return { version, origin: "release", assets };
}

export function devsyAgentRepairSuggestion(inspection: DevsyAgentInspection): string {
  if (inspection.state === "stale") {
    return `Install a supported Devsy release (${SUPPORTED_DEVSY_RANGE}) for a supported host, then run: ${DEVSY_AGENT_SETUP_COMMAND}`;
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

function managedBinaryPath(
  cacheRoot: string,
  devsyVersion: string,
  asset: DevsyAgentAsset,
): string {
  return path.join(cacheRoot, `v${devsyVersion}`, asset.name);
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
): Required<Pick<DevsyAgentOptions, "env" | "platform" | "arch" | "cacheRoot" | "lockPath">> &
  Pick<DevsyAgentOptions, "versionOutput" | "nativeAssetName" | "assets"> {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    versionOutput: options.versionOutput ?? installedVersionOutput(),
    cacheRoot: options.cacheRoot ?? path.join(CACHE_DIR, "devsy", "agents"),
    lockPath: options.lockPath ?? DEVSY_AGENT_CACHE_LOCK,
    assets: options.assets,
    nativeAssetName: options.nativeAssetName,
  };
}

export function inspectDevsyAgent(options: DevsyAgentOptions = {}): DevsyAgentInspection {
  const resolved = resolvedOptions(options);
  const installedVersion = parseVersion(resolved.versionOutput);
  const explicitPath = resolved.env.DEVSY_AGENT_BINARY?.trim();
  const source: DevsyAgentSource = explicitPath ? "explicit" : "managed";

  if (!installedVersion) {
    return {
      state: "stale",
      source,
      reason: `the installed Devsy version could not be determined; Devrouter supports ${SUPPORTED_DEVSY_RANGE}`,
    };
  }

  if (!isSupportedDevsyVersion(installedVersion)) {
    return {
      state: "stale",
      source,
      reason: `installed Devsy ${installedVersion} is outside the supported range ${SUPPORTED_DEVSY_RANGE}`,
      installedVersion,
    };
  }

  const manifest = manifestForVersion(resolved, installedVersion);
  if (!manifest) {
    if (explicitPath) {
      return {
        ...inspectBinary(explicitPath, resolved.assets ?? DEVSY_AGENT_ASSETS, "invalid"),
        source,
        binaryPath: explicitPath,
        installedVersion,
      };
    }
    // No verified manifest is recorded for this release yet. Devrouter injects
    // nothing rather than splicing in an unverified binary, so the host CLI
    // governs its own agent. An explicit setup resolves, verifies and records
    // the official agent for this release.
    return {
      state: "ready",
      source: "host",
      reason: `no verified Devsy ${installedVersion} agent manifest is recorded yet; the host CLI governs its own agent`,
      installedVersion,
      drift: { installed: installedVersion, supported: PINNED_DEVSY_AGENT_VERSION },
    };
  }

  const expectedName =
    resolved.nativeAssetName ?? nativeAssetName(resolved.platform, resolved.arch);
  const asset = manifest.assets.find((candidate) => candidate.name === expectedName);
  if (!asset) {
    return {
      state: "stale",
      source,
      reason: `Devsy ${installedVersion} has no official agent for ${resolved.platform}/${resolved.arch}`,
      installedVersion,
      manifestOrigin: manifest.origin,
    };
  }

  if (explicitPath) {
    return {
      ...inspectBinary(explicitPath, [asset], "invalid"),
      source,
      binaryPath: explicitPath,
      installedVersion,
      manifestOrigin: manifest.origin,
    };
  }

  const binaryPath = managedBinaryPath(resolved.cacheRoot, installedVersion, asset);
  return {
    ...inspectBinary(binaryPath, [asset], "missing"),
    source,
    binaryPath,
    asset,
    installedVersion,
    manifestOrigin: manifest.origin,
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
        throw new Error("Devsy agent download exceeded the expected size");
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

type ReadyDevsyAgentInspection = DevsyAgentInspection & {
  state: "ready";
  installedVersion: string;
};

function isReadyInspection(
  inspection: DevsyAgentInspection,
): inspection is ReadyDevsyAgentInspection {
  return inspection.state === "ready" && inspection.installedVersion !== undefined;
}

function preparedFromInspection(inspection: ReadyDevsyAgentInspection): PreparedDevsyAgent {
  return {
    version: inspection.installedVersion,
    binaryPath: inspection.binaryPath,
    source: inspection.source,
    asset: inspection.asset,
    changed: false,
    transport: "existing",
  };
}

function expectedAgentName(resolved: ReturnType<typeof resolvedOptions>): string | undefined {
  return resolved.nativeAssetName ?? nativeAssetName(resolved.platform, resolved.arch);
}

/** Pinned or previously recorded manifest first; published release metadata last. */
async function loadOrResolveManifest(
  resolved: ReturnType<typeof resolvedOptions>,
  version: string,
  options: PrepareDevsyAgentOptions,
): Promise<DevsyAgentManifest> {
  const manifest = manifestForVersion(resolved, version);
  if (manifest) return manifest;
  const release = await resolveReleaseDevsyAgentManifest(version, options.fetcher ?? fetch);
  writeManifestRecord(resolved.cacheRoot, release);
  return release;
}

export async function prepareDevsyAgent(
  options: PrepareDevsyAgentOptions = {},
): Promise<PreparedDevsyAgent> {
  const resolved = resolvedOptions(options);
  const inspectOptions: DevsyAgentOptions = resolved;
  const before = inspectDevsyAgent(inspectOptions);
  if (before.state === "stale") throw new DevsyAgentReadinessError(before);
  // A host-governed CLI is ready with nothing injected, but this explicit
  // setup path still resolves and records the verified agent for its release.
  if (isReadyInspection(before) && before.source !== "host") {
    return preparedFromInspection(before);
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
    if (current.state === "stale") throw new DevsyAgentReadinessError(current);
    if (isReadyInspection(current) && current.source !== "host") {
      return preparedFromInspection(current);
    }

    const version = current.installedVersion;
    if (!version) throw new DevsyAgentReadinessError(current);
    const manifest = await loadOrResolveManifest(resolved, version, options);

    if (current.source === "explicit") {
      // An operator-provided binary stays authoritative, but only once the
      // official manifest for this Devsy release proves what it must equal.
      const verified = inspectDevsyAgent(inspectOptions);
      if (isReadyInspection(verified)) return preparedFromInspection(verified);
      throw new DevsyAgentReadinessError(verified);
    }

    const asset = manifest.assets.find(
      (candidate) => candidate.name === expectedAgentName(resolved),
    );
    if (!asset) {
      throw new DevsyAgentReadinessError({
        state: "stale",
        source: current.source,
        reason: `Devsy ${version} has no official agent for ${resolved.platform}/${resolved.arch}`,
        installedVersion: version,
        manifestOrigin: manifest.origin,
      });
    }

    const transport = await downloadAndPublish(
      asset,
      managedBinaryPath(resolved.cacheRoot, version, asset),
      options.fetcher ?? fetch,
      options.githubCliDownloader ?? downloadWithGitHubCli,
    );
    const published = inspectDevsyAgent(inspectOptions);
    if (!isReadyInspection(published)) throw new DevsyAgentReadinessError(published);
    return { ...preparedFromInspection(published), changed: true, transport };
  });
}

export function requireReadyDevsyAgent(options: DevsyAgentOptions = {}): PreparedDevsyAgent {
  const inspection = inspectDevsyAgent(options);
  // A host-governed CLI is ready without a Devrouter-selected binary; the
  // caller only injects an agent when one was verified.
  if (!isReadyInspection(inspection)) throw new DevsyAgentReadinessError(inspection);
  return preparedFromInspection(inspection);
}
