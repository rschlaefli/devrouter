import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveRepoPath } from "./repo-config";

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const DEVROUTER_METADATA_FILE = "devrouter.yaml";
export const CHANGELOG_URL = "https://github.com/rschlaefli/devrouter/blob/main/CHANGELOG.md";

export type UpgradeRelease = {
  version: string;
  prompt: string;
};

export type UpgradeCatalog = {
  repoPath: string;
  metadataPath: string;
  changelogPath: string;
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
    throw new Error(`Invalid version '${version}'. Expected semantic version like 0.0.13.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
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

function resolveVersionValue(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "string") {
    return normalizeVersion(String(value));
  }

  return undefined;
}

export function extractCurrentVersionFromMetadata(content: string, metadataPath: string): string {
  const parsed = YAML.parse(content) as unknown;

  const directVersion = resolveVersionValue(parsed);
  if (directVersion) {
    return directVersion;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${metadataPath} must define a devrouter version as semver (for example 0.0.13). ` +
        "Supported keys: version, devrouter.version, devrouterVersion."
    );
  }

  const root = parsed as Record<string, unknown>;
  const topLevelVersion = resolveVersionValue(root.version);
  if (topLevelVersion) {
    return topLevelVersion;
  }

  const aliasedVersion = resolveVersionValue(root.devrouterVersion);
  if (aliasedVersion) {
    return aliasedVersion;
  }

  if (root.devrouter && typeof root.devrouter === "object" && !Array.isArray(root.devrouter)) {
    const nestedVersion = resolveVersionValue((root.devrouter as Record<string, unknown>).version);
    if (nestedVersion) {
      return nestedVersion;
    }
  }

  throw new Error(
    `${metadataPath} must define a devrouter version as semver (for example 0.0.13). ` +
      "Supported keys: version, devrouter.version, devrouterVersion."
  );
}

export function parseChangelogReleases(changelog: string): UpgradeRelease[] {
  const headingRe = /^## \[(\d+\.\d+\.\d+)\] - [^\n]*$/gm;
  const headings: Array<{ version: string; start: number; end: number }> = [];
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingRe.exec(changelog)) !== null) {
    headings.push({
      version: normalizeVersion(headingMatch[1]),
      start: headingMatch.index,
      end: headingRe.lastIndex
    });
  }

  const releases: UpgradeRelease[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const nextHeading = headings[index + 1];
    const sectionEnd = nextHeading ? nextHeading.start : changelog.length;
    const sectionBody = changelog.slice(heading.end, sectionEnd);
    const promptMatch = sectionBody.match(
      /### Agent Adaptation Prompt\s*[\r\n]+```text[\r\n]([\s\S]*?)```/m
    );
    if (!promptMatch) {
      continue;
    }

    releases.push({
      version: heading.version,
      prompt: promptMatch[1].trim()
    });
  }

  const unique = new Map<string, UpgradeRelease>();
  for (const release of releases) {
    unique.set(release.version, release);
  }

  return Array.from(unique.values()).sort((a, b) => compareVersions(a.version, b.version));
}

export function listAvailableUpgradeTargets(
  currentVersion: string,
  releases: UpgradeRelease[]
): UpgradeRelease[] {
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  return releases
    .filter((release) => compareVersions(release.version, normalizedCurrentVersion) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

export function resolveBundledChangelogPath(): string {
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : __filename;
  const entryDir = path.dirname(entryFile);
  const candidates = [
    path.resolve(entryDir, "..", "CHANGELOG.md"),
    path.resolve(__dirname, "..", "CHANGELOG.md"),
    path.resolve(__dirname, "..", "..", "CHANGELOG.md"),
    path.resolve(process.cwd(), "CHANGELOG.md")
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing ?? candidates[0];
}

export function loadUpgradeCatalog(options: {
  repo?: string;
  metadataFile?: string;
  changelogPath?: string;
} = {}): UpgradeCatalog {
  const repoPath = resolveRepoPath(options.repo);
  const metadataPath = path.join(repoPath, options.metadataFile ?? DEVROUTER_METADATA_FILE);
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Missing ${options.metadataFile ?? DEVROUTER_METADATA_FILE} in ${repoPath}.`);
  }

  const currentVersion = extractCurrentVersionFromMetadata(
    fs.readFileSync(metadataPath, "utf-8"),
    metadataPath
  );
  const changelogPath = options.changelogPath ?? resolveBundledChangelogPath();
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`Missing CHANGELOG.md at ${changelogPath}. Use release guidance at ${CHANGELOG_URL}.`);
  }

  const releases = parseChangelogReleases(fs.readFileSync(changelogPath, "utf-8"));
  if (releases.length === 0) {
    throw new Error(
      `No 'Agent Adaptation Prompt' entries were found in ${changelogPath}. Use ${CHANGELOG_URL}.`
    );
  }

  return {
    repoPath,
    metadataPath,
    changelogPath,
    currentVersion,
    releases
  };
}
