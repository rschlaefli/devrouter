import path from "node:path";

/**
 * Ensures that `filePath` resolves to a location within `repoRoot`.
 * Returns the resolved absolute path. Throws if the path escapes the repo.
 */
export function assertPathWithinRepo(filePath: string, repoRoot: string, label: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(repoRoot, filePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`${label} path '${filePath}' escapes the repository root.`);
  }

  return resolved;
}
