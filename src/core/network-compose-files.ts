import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { writeFileAtomically } from "./atomic-file";
import {
  MANAGED_DEVCONTAINER_MARKER,
  type ManagedDevcontainerPlan,
  managedComposeEnvironment,
} from "./devcontainer-profile";
import {
  type AuthoredNetworkDeclarations,
  deriveComposeNetworkOverlay,
  extendDockerComposeFile,
  type NormalizedComposeJson,
} from "./network-compose";

const OVERLAY = "docker-compose.devrouter-network.yml";
const MARKER = "# devrouter:managed workspace network";
const MAX_BYTES = 2 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Network Compose evidence is malformed.");
  return value as Record<string, unknown>;
}

/** Keep the resolved model in memory: it may include application configuration. */
export function inspectNetworkComposeFiles(input: {
  plan: ManagedDevcontainerPlan;
  endpoint: string;
  workspace: { token: string; gitCommonDir: string };
}): { compose: NormalizedComposeJson; authoredNetworks: AuthoredNetworkDeclarations } {
  const authoredNetworks: AuthoredNetworkDeclarations = {};
  for (const file of input.plan.composeFiles) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("Network Compose source is unavailable or too large.");
    let source: Record<string, unknown>;
    try {
      source = object(YAML.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // Parser diagnostics can include application values from the source line.
      throw new Error("Network Compose source could not be parsed safely.");
    }
    if (source.networks !== undefined) {
      for (const [name, declaration] of Object.entries(object(source.networks))) {
        // Conservative union retains an earlier explicit reservation even if a
        // later Compose override would remove it.
        authoredNetworks[name] = {
          ...authoredNetworks[name],
          ...(declaration === null ? {} : object(declaration)),
        };
      }
    }
  }
  const env = managedComposeEnvironment(input.workspace);
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  const result = spawnSync(
    "docker",
    [
      "--host",
      input.endpoint,
      "compose",
      "--profile",
      "*",
      ...input.plan.composeFiles.flatMap((file) => ["-f", file]),
      "config",
      "--format",
      "json",
      "--no-interpolate",
      "--no-env-resolution",
    ],
    {
      cwd: input.plan.composeDirectory,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: MAX_BYTES,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Complete network Compose evidence is unavailable.");
  try {
    return { compose: object(JSON.parse(result.stdout)), authoredNetworks };
  } catch {
    throw new Error("Network Compose evidence is malformed.");
  }
}

/** Called only after durable reservation; native files remain unchanged. */
export function prepareNetworkComposeFiles(
  plan: ManagedDevcontainerPlan,
  subnet: string,
): {
  plan: ManagedDevcontainerPlan;
  write: () => void;
} {
  const overlay = deriveComposeNetworkOverlay(subnet);
  if (overlay.status !== "ready" || !overlay.overlay) throw new Error("Network subnet is invalid.");
  const overlayPath = path.join(plan.composeDirectory, OVERLAY);
  const ignored = spawnSync("git", [
    "-C",
    plan.composeDirectory,
    "check-ignore",
    "--quiet",
    "--no-index",
    "--",
    overlayPath,
  ]);
  if (ignored.status !== 0)
    throw new Error("Generated network overlay must be ignored before allocation.");
  const bytes = `${MARKER}\n${YAML.stringify(overlay.overlay)}`;
  const assertOwnership = () => {
    if (!fs.existsSync(overlayPath)) return;
    const stat = fs.lstatSync(overlayPath);
    if (!stat.isFile() || stat.size > MAX_BYTES || fs.readFileSync(overlayPath, "utf8") !== bytes)
      throw new Error("Retained network overlay changed; repair is required.");
  };
  assertOwnership();
  const config = JSON.parse(plan.contents.slice(plan.contents.indexOf("\n") + 1));
  const extended = extendDockerComposeFile(config, OVERLAY);
  if (!extended.config) throw new Error("Network effective configuration could not be derived.");
  const contents = `${MANAGED_DEVCONTAINER_MARKER}\n${JSON.stringify(extended.config, null, 2)}\n`;
  const result = {
    ...plan,
    contents,
    composeFiles: [...plan.composeFiles, overlayPath],
    effectiveConfigSha256: createHash("sha256").update(contents).digest("hex"),
  };
  return {
    plan: result,
    write: () => {
      assertOwnership();
      writeFileAtomically(overlayPath, bytes);
    },
  };
}
