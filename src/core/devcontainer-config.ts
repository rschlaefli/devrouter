import fs from "node:fs";
import path from "node:path";
import { type ParseError, parse } from "jsonc-parser";

export type DevcontainerConfig = Record<string, unknown>;

function isObject(value: unknown): value is DevcontainerConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseDevcontainerConfig(contents: string, sourcePath: string): DevcontainerConfig {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(contents, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Could not parse Dev Container source config '${sourcePath}' as JSONC at offset ${first.offset}.`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error(`Dev Container source config '${sourcePath}' must contain an object.`);
  }
  return parsed;
}

export function readDevcontainerConfig(repoPath: string): {
  sourcePath: string;
  sourceContents: string;
  source: DevcontainerConfig;
} {
  const sourcePath = path.join(repoPath, ".devcontainer", "devcontainer.json");
  if (!fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isFile()) {
    throw new Error(`Managed Dev Container source config does not exist: ${sourcePath}`);
  }
  const sourceContents = fs.readFileSync(sourcePath, "utf-8");
  return {
    sourcePath,
    sourceContents,
    source: parseDevcontainerConfig(sourceContents, sourcePath),
  };
}

export function assertManagedDevcontainerLifecycle(repoPath: string): void {
  const { sourcePath, source } = readDevcontainerConfig(repoPath);
  if (source.postCreateCommand === undefined) return;

  if (source.waitFor === "postCreateCommand" || source.waitFor === "postStartCommand") return;

  const actual =
    source.waitFor === undefined
      ? "is missing"
      : typeof source.waitFor === "string"
        ? "is an unsupported string"
        : "is not a string";
  throw new Error(
    `Managed Dev Container source '${sourcePath}' defines postCreateCommand, but waitFor ${actual}. Set waitFor to 'postCreateCommand' or 'postStartCommand' before retrying devrouter ensure.`,
  );
}
