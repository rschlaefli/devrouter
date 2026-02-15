import { describe, expect, it } from "vitest";
import {
  compareVersions,
  extractCurrentVersionFromMetadata,
  listAvailableUpgradeTargets,
  normalizeVersion,
  parseChangelogReleases
} from "../upgrade";

const CHANGELOG_FIXTURE = `
## [0.0.12] - 2026-02-15

### Agent Adaptation Prompt

\`\`\`text
Prompt 12
\`\`\`

## [0.0.11] - 2026-02-15

### Agent Adaptation Prompt

\`\`\`text
Prompt 11
\`\`\`

## [0.0.10] - 2026-02-15

### Agent Adaptation Prompt

\`\`\`text
Prompt 10
\`\`\`
`;

describe("upgrade core", () => {
  it("normalizes and compares semver values", () => {
    expect(normalizeVersion("v0.0.13")).toBe("0.0.13");
    expect(compareVersions("0.0.10", "0.0.11")).toBeLessThan(0);
    expect(compareVersions("0.0.12", "0.0.11")).toBeGreaterThan(0);
  });

  it("extracts current version from supported devrouter.yaml fields", () => {
    expect(
      extractCurrentVersionFromMetadata("version: 0.0.10\n", "/repo/devrouter.yaml")
    ).toBe("0.0.10");
    expect(
      extractCurrentVersionFromMetadata("devrouterVersion: 0.0.11\n", "/repo/devrouter.yaml")
    ).toBe("0.0.11");
    expect(
      extractCurrentVersionFromMetadata("devrouter:\n  version: 0.0.12\n", "/repo/devrouter.yaml")
    ).toBe("0.0.12");
  });

  it("extracts changelog releases sorted ascending", () => {
    const releases = parseChangelogReleases(CHANGELOG_FIXTURE);
    expect(releases.map((release) => release.version)).toEqual(["0.0.10", "0.0.11", "0.0.12"]);
    expect(releases[1]?.prompt).toContain("Prompt 11");
  });

  it("lists only versions newer than current", () => {
    const releases = parseChangelogReleases(CHANGELOG_FIXTURE);
    const targets = listAvailableUpgradeTargets("0.0.10", releases);
    expect(targets.map((release) => release.version)).toEqual(["0.0.11", "0.0.12"]);
  });
});
