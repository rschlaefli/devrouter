import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DevrouterConfig, DevrouterProfile } from "../types";
import { writeFileAtomically } from "./atomic-file";
import { readDevcontainerConfig } from "./devcontainer-config";
import { assertPathWithinRepo } from "./paths";

export const MANAGED_DEVCONTAINER_PATH = ".devcontainer/devcontainer.devrouter.json";
export const MANAGED_DEVCONTAINER_MARKER = "// devrouter:managed devcontainer profile";

type JsonObject = Record<string, unknown>;

export type ManagedDevcontainerPlan = {
  sourcePath: string;
  generatedPath: string;
  generatedRelativePath: string;
  sourceConfigSha256: string;
  effectiveConfigSha256: string;
  primaryService: string;
  composeDirectory: string;
  composeFiles: string[];
  composeServices: string[];
  nativeRunServices: string[];
  baseServices: string[];
  profileServices: string[];
  desiredProfileServices: string[];
  desiredServices: string[];
  contents: string;
};

export type ManagedDevcontainerGeneratedStatus = {
  status: "valid" | "missing" | "foreign" | "drifted";
  sha256?: string;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const result = value.map((item) => (item as string).trim());
  if (result.some((item) => item.length === 0)) {
    throw new Error(`${label} must not contain empty strings.`);
  }
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
  return result;
}

function resolveComposeReference(value: string, linked: boolean): string {
  return value.replace(
    /\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      if (name === "DEVCONTAINER_COMPOSE_OVERLAY" && linked) {
        return "docker-compose.devrouter.yml";
      }
      if (fallback !== undefined) return fallback;
      throw new Error(
        `Cannot resolve localEnv '${name}' while validating the managed Dev Container config.`,
      );
    },
  );
}

function resolveComposeFiles(
  source: JsonObject,
  repoPath: string,
  linked: boolean,
): { directory: string; files: string[]; services: string[] } {
  const composeValue = source.dockerComposeFile;
  const references =
    typeof composeValue === "string"
      ? [composeValue]
      : Array.isArray(composeValue) && composeValue.every((item) => typeof item === "string")
        ? (composeValue as string[])
        : [];
  if (references.length === 0) {
    throw new Error(
      "managedRuntime requires .devcontainer/devcontainer.json to define dockerComposeFile.",
    );
  }

  const directory = path.join(repoPath, ".devcontainer");
  const files = references.map((reference) => {
    const resolved = assertPathWithinRepo(
      resolveComposeReference(reference, linked),
      directory,
      "dockerComposeFile",
    );
    if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
      throw new Error(`Managed Dev Container compose file does not exist: ${resolved}`);
    }
    return resolved;
  });

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(fs.readFileSync(file, "utf-8"));
    } catch (error) {
      throw new Error(
        `Could not parse managed Dev Container compose file '${file}': ${String(error)}`,
      );
    }
    if (!isObject(parsed) || !isObject(parsed.services)) {
      throw new Error(`Managed Dev Container compose file '${file}' has no services map.`);
    }
  }
  const fileArgs = files.flatMap((file) => ["-f", file]);
  const resolved = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--project-directory",
      directory,
      ...fileArgs,
      "config",
      "--services",
      "--no-interpolate",
      "--no-env-resolution",
    ],
    { cwd: directory, encoding: "utf-8" },
  );
  if (resolved.status !== 0) {
    throw new Error("Could not resolve the effective managed Dev Container Compose model.");
  }
  const services = String(resolved.stdout ?? "")
    .split(/\r?\n/)
    .map((service) => service.trim())
    .filter(Boolean);
  if (services.length === 0 || new Set(services).size !== services.length) {
    throw new Error("The effective managed Dev Container Compose model has no unique services.");
  }
  return { directory, files, services: services.sort() };
}

function assertIgnoredGeneratedPath(repoPath: string, generatedPath: string): void {
  const ignored = spawnSync(
    "git",
    ["-C", repoPath, "check-ignore", "--quiet", "--no-index", "--", generatedPath],
    { encoding: "utf-8" },
  );
  if (ignored.status !== 0) {
    throw new Error(
      `Managed Dev Container path '${generatedPath}' must be ignored before devrouter can generate it.`,
    );
  }
}

function assertGeneratedPathOwnership(generatedPath: string): void {
  if (!fs.existsSync(generatedPath)) return;
  const stat = fs.lstatSync(generatedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Managed Dev Container path '${generatedPath}' is not a regular file.`);
  }
  const firstLine = fs.readFileSync(generatedPath, "utf-8").split(/\r?\n/, 1)[0];
  if (firstLine !== MANAGED_DEVCONTAINER_MARKER) {
    throw new Error(
      `Managed Dev Container path '${generatedPath}' exists without the devrouter ownership marker.`,
    );
  }
}

function isWildcard(values: string[] | undefined): boolean {
  return values?.length === 1 && values[0] === "*";
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf-8").digest("hex");
}

function safeComposeProject(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`Docker Compose project '${value}' is not a safe exact identifier.`);
  }
  return value;
}

export function inspectManagedDevcontainerConfig(options: {
  repoPath: string;
  config: DevrouterConfig;
  profile?: DevrouterProfile;
  linked: boolean;
}): ManagedDevcontainerPlan {
  const managedRuntime = options.config.managedRuntime;
  if (!managedRuntime) {
    throw new Error("Cannot prepare a managed Dev Container without managedRuntime.");
  }
  const { sourcePath, sourceContents, source } = readDevcontainerConfig(options.repoPath);
  const primaryService = nonEmptyString(source.service, "devcontainer.service");
  const compose = resolveComposeFiles(source, options.repoPath, options.linked);
  const composeServiceSet = new Set(compose.services);
  if (!composeServiceSet.has(primaryService)) {
    throw new Error(`devcontainer.service '${primaryService}' is not in the Compose model.`);
  }

  const nativeRunServices =
    source.runServices === undefined
      ? compose.services
      : stringArray(source.runServices, "devcontainer.runServices");
  for (const service of nativeRunServices) {
    if (!composeServiceSet.has(service)) {
      throw new Error(`devcontainer.runServices references unknown service '${service}'.`);
    }
  }
  if (!nativeRunServices.includes(primaryService)) {
    throw new Error(`devcontainer.runServices must include primary service '${primaryService}'.`);
  }

  const baseServices = managedRuntime.devcontainer.baseServices;
  const profileServices = managedRuntime.devcontainer.profileServices;
  for (const service of [...baseServices, ...profileServices]) {
    if (!composeServiceSet.has(service)) {
      throw new Error(`managedRuntime references unknown Compose service '${service}'.`);
    }
    if (!nativeRunServices.includes(service)) {
      throw new Error(`managedRuntime service '${service}' is missing from native runServices.`);
    }
  }
  if (baseServices.includes(primaryService) || profileServices.includes(primaryService)) {
    throw new Error(`managedRuntime must not classify primary service '${primaryService}'.`);
  }
  const classified = new Set([primaryService, ...baseServices, ...profileServices]);
  const unclassified = nativeRunServices.filter((service) => !classified.has(service));
  if (unclassified.length > 0) {
    throw new Error(
      `managedRuntime does not classify native runServices: ${unclassified.join(", ")}.`,
    );
  }

  const desiredProfileServices =
    !options.profile || isWildcard(options.profile.devcontainerServices)
      ? [...profileServices]
      : [...(options.profile.devcontainerServices ?? [])];
  const unregisteredDesiredServices = desiredProfileServices.filter(
    (service) => !profileServices.includes(service),
  );
  if (unregisteredDesiredServices.length > 0) {
    throw new Error(
      `Profile selects unregistered managed services: ${unregisteredDesiredServices.join(", ")}.`,
    );
  }
  const desiredSet = new Set([primaryService, ...baseServices, ...desiredProfileServices]);
  const desiredServices = nativeRunServices.filter((service) => desiredSet.has(service));
  const effective = JSON.parse(JSON.stringify(source)) as JsonObject;
  effective.runServices = desiredServices;
  const contents = `${MANAGED_DEVCONTAINER_MARKER}\n${JSON.stringify(effective, null, 2)}\n`;
  const generatedPath = path.join(options.repoPath, MANAGED_DEVCONTAINER_PATH);
  assertIgnoredGeneratedPath(options.repoPath, generatedPath);
  assertGeneratedPathOwnership(generatedPath);

  return {
    sourcePath,
    generatedPath,
    generatedRelativePath: MANAGED_DEVCONTAINER_PATH,
    sourceConfigSha256: sha256(sourceContents),
    effectiveConfigSha256: sha256(contents),
    primaryService,
    composeDirectory: compose.directory,
    composeFiles: compose.files,
    composeServices: compose.services,
    nativeRunServices,
    baseServices: [...baseServices],
    profileServices: [...profileServices],
    desiredProfileServices,
    desiredServices,
    contents,
  };
}

export function writeManagedDevcontainerConfig(plan: ManagedDevcontainerPlan): void {
  writeFileAtomically(plan.generatedPath, plan.contents);
}

export function inspectManagedDevcontainerGeneratedConfig(
  plan: ManagedDevcontainerPlan,
): ManagedDevcontainerGeneratedStatus {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(plan.generatedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: "foreign" };

  const contents = fs.readFileSync(plan.generatedPath, "utf-8");
  if (!contents.startsWith(`${MANAGED_DEVCONTAINER_MARKER}\n`)) {
    return { status: "foreign" };
  }
  const fingerprint = sha256(contents);
  return {
    status: fingerprint === plan.effectiveConfigSha256 ? "valid" : "drifted",
    sha256: fingerprint,
  };
}

export function removeManagedDevcontainerConfig(plan: ManagedDevcontainerPlan): void {
  if (!fs.existsSync(plan.generatedPath)) return;
  const stat = fs.lstatSync(plan.generatedPath);
  if (!stat.isFile()) {
    throw new Error(`Managed Dev Container path '${plan.generatedPath}' is not a regular file.`);
  }
  const contents = fs.readFileSync(plan.generatedPath, "utf-8");
  if (!contents.startsWith(`${MANAGED_DEVCONTAINER_MARKER}\n`)) {
    throw new Error(`Managed Dev Container path '${plan.generatedPath}' is not devrouter-owned.`);
  }
  fs.unlinkSync(plan.generatedPath);
}

export function prepareManagedDevcontainerConfig(options: {
  repoPath: string;
  config: DevrouterConfig;
  profile?: DevrouterProfile;
  linked: boolean;
}): ManagedDevcontainerPlan {
  const plan = inspectManagedDevcontainerConfig(options);
  writeManagedDevcontainerConfig(plan);
  return plan;
}

function assertSafeContainerId(containerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) {
    throw new Error(`Container '${containerId}' is not a safe exact identifier.`);
  }
}

export function startExactManagedServices(options: {
  plan: ManagedDevcontainerPlan;
  composeProject: string;
  services: string[];
  quiet?: boolean;
  workspace?: { token: string; gitCommonDir: string };
}): void {
  if (options.services.length === 0) return;
  const project = safeComposeProject(options.composeProject);
  const services = Array.from(new Set(options.services));
  if (services.some((service) => !options.plan.composeServices.includes(service))) {
    throw new Error("Exact Compose startup contains a service outside the validated model.");
  }
  const fileArgs = options.plan.composeFiles.flatMap((file) => ["-f", file]);
  // Mirror the environment DevPod itself receives: linked overlays resolve
  // their bind mounts from these variables, while a primary checkout must see
  // the compose defaults instead of any stale host values.
  const env = { ...process.env };
  if (options.workspace) {
    env.WORKSPACE = options.workspace.token;
    env.DEVROUTER_WORKSPACE = options.workspace.token;
    env.DEVROUTER_GIT_COMMON_DIR = options.workspace.gitCommonDir;
    env.DEVCONTAINER_COMPOSE_OVERLAY = "docker-compose.devrouter.yml";
  } else {
    delete env.WORKSPACE;
    delete env.DEVROUTER_WORKSPACE;
    delete env.DEVROUTER_GIT_COMMON_DIR;
    delete env.DEVCONTAINER_COMPOSE_OVERLAY;
  }
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--project-directory",
      options.plan.composeDirectory,
      ...fileArgs,
      "up",
      "-d",
      "--no-recreate",
      "--no-deps",
      ...services,
    ],
    {
      cwd: options.plan.composeDirectory,
      encoding: "utf-8",
      env,
      stdio: options.quiet ? ["ignore", 2, "inherit"] : "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Exact Compose startup failed for project '${project}' and service set '${services.join(",")}'.`,
    );
  }
}

export function stopExactManagedService(containerId: string, service: string): void {
  assertSafeContainerId(containerId);
  const result = spawnSync("docker", ["stop", containerId], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Could not stop exact managed service '${service}' (${containerId}).`);
  }
}
