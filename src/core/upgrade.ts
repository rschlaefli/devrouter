import fs from "node:fs";
import path from "node:path";
import { getRepoConfigPath, loadRepoConfig, resolveRepoPath } from "./repo-config";

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const UPGRADE_PROMPTS_DIR = "upgrade-prompts";

export type UpgradeRelease = {
  version: string;
  prompt: string;
  promptPath: string;
};

export type UpgradeCatalog = {
  repoPath: string;
  configPath: string;
  promptsPath: string;
  currentVersion: string;
  releases: UpgradeRelease[];
};

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
};

function parseSemver(version: string): ParsedSemver {
  const normalized = version.trim();
  const match = normalized.match(SEMVER_RE);
  if (!match) {
    throw new Error(`Invalid version '${version}'. Expected semantic version like 0.0.14.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function normalizeVersion(version: string): string {
  const parsed = parseSemver(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function formatMissingVersionError(configPath: string): string {
  return (
    `${configPath} is missing devrouter.version.\n` +
    "Add release metadata to .devrouter.yml, for example:\n\n" +
    "version: 1\n" +
    "devrouter:\n" +
    "  version: 0.0.14\n" +
    "apps: []\n"
  );
}

export function extractCurrentVersionFromRepoConfig(repoPath?: string): {
  configPath: string;
  version: string;
} {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  const config = loadRepoConfig(resolvedRepoPath);
  const version = config.devrouter?.version;
  if (!version) {
    throw new Error(formatMissingVersionError(configPath));
  }

  return {
    configPath,
    version: normalizeVersion(version),
  };
}

export function readPromptDirectory(promptDirPath: string): UpgradeRelease[] {
  if (!fs.existsSync(promptDirPath)) {
    throw new Error(`Missing ${UPGRADE_PROMPTS_DIR} directory at ${promptDirPath}.`);
  }

  const releases: UpgradeRelease[] = [];
  const files = fs.readdirSync(promptDirPath, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".md")) {
      continue;
    }

    const basename = file.name.slice(0, -3);
    if (!SEMVER_RE.test(basename)) {
      continue;
    }

    const version = normalizeVersion(basename);
    const promptPath = path.join(promptDirPath, file.name);
    const prompt = fs.readFileSync(promptPath, "utf-8").trim();
    releases.push({ version, prompt, promptPath });
  }

  const deduped = new Map<string, UpgradeRelease>();
  for (const release of releases) {
    deduped.set(release.version, release);
  }

  const ordered = Array.from(deduped.values()).sort((a, b) =>
    compareVersions(a.version, b.version),
  );
  if (ordered.length === 0) {
    throw new Error(`No semantic-version prompt files were found in ${promptDirPath}.`);
  }

  return ordered;
}

export function listAvailableUpgradeTargets(
  currentVersion: string,
  releases: UpgradeRelease[],
): UpgradeRelease[] {
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  return releases
    .filter((release) => compareVersions(release.version, normalizedCurrentVersion) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

export function resolvePromptDirectory(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : __filename;
  const entryDir = path.dirname(entryFile);
  const candidates = [
    path.resolve(entryDir, "..", UPGRADE_PROMPTS_DIR),
    path.resolve(__dirname, "..", "..", UPGRADE_PROMPTS_DIR),
    path.resolve(process.cwd(), UPGRADE_PROMPTS_DIR),
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing ?? candidates[0];
}

export function loadUpgradeCatalog(
  options: { repo?: string; promptsDir?: string } = {},
): UpgradeCatalog {
  const repoPath = resolveRepoPath(options.repo);
  const current = extractCurrentVersionFromRepoConfig(repoPath);
  const promptsPath = resolvePromptDirectory(options.promptsDir);
  const releases = readPromptDirectory(promptsPath);

  return {
    repoPath,
    configPath: current.configPath,
    promptsPath,
    currentVersion: current.version,
    releases,
  };
}
