import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { DevrouterConfig } from "../types";
import { assertPathWithinRepo } from "./paths";
import { buildProfileResolutionReport, type ProfileResolutionReport } from "./profile-resolution";
import { loadRepoConfig, resolveRepoPath } from "./repo-config";

const CONTRACT_VERSION = 1;
const MAX_CONTRACT_BYTES = 1024 * 1024;
const MAX_APP_MAPPINGS = 256;
const MAX_BINDING_KEYS = 64;
const MAX_BINDING_VALUES = 4096;
const MAX_LITERAL_LENGTH = 4096;
const BINDING_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

type AppMapping = {
  bindings: Record<string, string[]>;
};

export type ProfilePlanContract = {
  version: 1;
  apps: {
    requireNonEmpty: boolean;
    mappings: Record<string, AppMapping>;
  };
  dependencies: { allowed: string[] };
  managedRuntime: {
    services: { allowed: string[] };
    processes: { exact: string[] };
  };
};

export type ProfilePlanReport = ProfileResolutionReport & {
  contractPath: string;
  bindings: Record<string, string[]>;
};

export type ProfilePlanResourceRegistry = {
  apps: string[];
  dependencies: string[];
  managedServices: string[];
  managedProcesses: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be a mapping.`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(`${label} has unsupported keys: ${unknown.sort().join(", ")}.`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label} is missing keys: ${missing.join(", ")}.`);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function requireStringList(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be an array of strings.`);
  }
  if (options.allowEmpty === false && value.length === 0) fail(`${label} must not be empty.`);
  for (const entry of value) {
    if (entry.length === 0) fail(`${label} must not contain empty strings.`);
    if (entry.length > MAX_LITERAL_LENGTH) {
      fail(`${label} contains a value longer than ${MAX_LITERAL_LENGTH} characters.`);
    }
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicates.`);
  return [...value];
}

function parseMappings(value: unknown): Record<string, AppMapping> {
  const input = requireRecord(value, "apps.mappings");
  const entries = Object.entries(input);
  if (entries.length > MAX_APP_MAPPINGS) {
    fail(`apps.mappings exceeds the limit of ${MAX_APP_MAPPINGS}.`);
  }

  const mappings: Array<[string, AppMapping]> = [];
  const allBindingKeys = new Set<string>();
  let bindingValues = 0;

  for (const [appName, rawMapping] of entries) {
    if (appName.length === 0) fail("apps.mappings must not contain an empty app name.");
    const mapping = requireRecord(rawMapping, `apps.mappings.${appName}`);
    requireExactKeys(mapping, ["bindings"], `apps.mappings.${appName}`);
    const rawBindings = requireRecord(mapping.bindings, `apps.mappings.${appName}.bindings`);
    if (Object.keys(rawBindings).length === 0) {
      fail(`apps.mappings.${appName}.bindings must not be empty.`);
    }

    const bindings: Array<[string, string[]]> = [];
    for (const [key, rawValues] of Object.entries(rawBindings)) {
      if (!BINDING_KEY.test(key)) {
        fail(`binding key '${key}' must match ${BINDING_KEY.source}.`);
      }
      const values = requireStringList(rawValues, `apps.mappings.${appName}.bindings.${key}`, {
        allowEmpty: false,
      });
      allBindingKeys.add(key);
      bindingValues += values.length;
      bindings.push([key, values]);
    }
    mappings.push([appName, { bindings: Object.fromEntries(bindings) }]);
  }

  if (allBindingKeys.size > MAX_BINDING_KEYS) {
    fail(`contract exceeds the limit of ${MAX_BINDING_KEYS} binding keys.`);
  }
  if (bindingValues > MAX_BINDING_VALUES) {
    fail(`contract exceeds the limit of ${MAX_BINDING_VALUES} binding values.`);
  }
  return Object.fromEntries(mappings);
}

export function parseProfilePlanContract(source: string): ProfilePlanContract {
  const document = parseDocument(source, {
    merge: false,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(`profile plan contract is invalid YAML: ${document.errors[0]?.message}`);
  }
  if (document.warnings.length > 0) {
    fail(`profile plan contract has unsupported YAML: ${document.warnings[0]?.message}`);
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    fail(`profile plan contract could not be converted: ${(error as Error).message}`);
  }

  const contract = requireRecord(raw, "profile plan contract");
  requireExactKeys(
    contract,
    ["version", "apps", "dependencies", "managedRuntime"],
    "profile plan contract",
  );
  if (contract.version !== CONTRACT_VERSION) {
    fail(`unsupported profile plan contract version ${String(contract.version)}.`);
  }

  const apps = requireRecord(contract.apps, "apps");
  requireExactKeys(apps, ["requireNonEmpty", "mappings"], "apps");
  const dependencies = requireRecord(contract.dependencies, "dependencies");
  requireExactKeys(dependencies, ["allowed"], "dependencies");
  const managedRuntime = requireRecord(contract.managedRuntime, "managedRuntime");
  requireExactKeys(managedRuntime, ["services", "processes"], "managedRuntime");
  const services = requireRecord(managedRuntime.services, "managedRuntime.services");
  requireExactKeys(services, ["allowed"], "managedRuntime.services");
  const processes = requireRecord(managedRuntime.processes, "managedRuntime.processes");
  requireExactKeys(processes, ["exact"], "managedRuntime.processes");

  return {
    version: CONTRACT_VERSION,
    apps: {
      requireNonEmpty: requireBoolean(apps.requireNonEmpty, "apps.requireNonEmpty"),
      mappings: parseMappings(apps.mappings),
    },
    dependencies: {
      allowed: requireStringList(dependencies.allowed, "dependencies.allowed"),
    },
    managedRuntime: {
      services: {
        allowed: requireStringList(services.allowed, "managedRuntime.services.allowed"),
      },
      processes: {
        exact: requireStringList(processes.exact, "managedRuntime.processes.exact"),
      },
    },
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function registryFor(config: DevrouterConfig): ProfilePlanResourceRegistry {
  const managedRuntime = config.managedRuntime;
  return {
    apps: sortedUnique(
      config.apps.filter((app) => app.kind !== "dependency").map((app) => app.name),
    ),
    dependencies: sortedUnique(
      config.apps.filter((app) => app.kind === "dependency").map((app) => app.name),
    ),
    managedServices: sortedUnique([
      ...(managedRuntime?.devcontainer.baseServices ?? []),
      ...(managedRuntime?.devcontainer.profileServices ?? []),
    ]),
    managedProcesses: sortedUnique(managedRuntime?.processes ?? []),
  };
}

function assertKnown(values: string[], registry: string[], label: string): void {
  const known = new Set(registry);
  const unknown = values.filter((value) => !known.has(value));
  if (unknown.length > 0) fail(`${label} contains unknown resources: ${unknown.join(", ")}.`);
}

function assertAllowed(selected: string[], allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unsupported = selected.filter((value) => !allowedSet.has(value));
  if (unsupported.length > 0) {
    fail(`${label} selects unsupported resources: ${unsupported.join(", ")}.`);
  }
}

function assertExact(selected: string[], expected: string[], label: string): void {
  const left = sortedUnique(selected);
  const right = sortedUnique(expected);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    fail(`${label} must equal [${right.join(", ")}], received [${left.join(", ")}].`);
  }
}

export function buildProfilePlanReport(options: {
  report: ProfileResolutionReport;
  contract: ProfilePlanContract;
  registry: ProfilePlanResourceRegistry;
  contractPath: string;
}): ProfilePlanReport {
  const { report, contract, registry, contractPath } = options;
  assertKnown(Object.keys(contract.apps.mappings), registry.apps, "apps.mappings");
  assertKnown(contract.dependencies.allowed, registry.dependencies, "dependencies.allowed");
  assertKnown(
    contract.managedRuntime.services.allowed,
    registry.managedServices,
    "managedRuntime.services.allowed",
  );
  assertKnown(
    contract.managedRuntime.processes.exact,
    registry.managedProcesses,
    "managedRuntime.processes.exact",
  );

  if (contract.apps.requireNonEmpty && report.apps.length === 0) {
    fail("selected profile must contain at least one app for this contract.");
  }
  const unmapped = report.apps.filter((app) => !Object.hasOwn(contract.apps.mappings, app));
  if (unmapped.length > 0) fail(`selected apps have no contract mapping: ${unmapped.join(", ")}.`);
  assertAllowed(report.dependencies, contract.dependencies.allowed, "dependencies");
  assertAllowed(
    report.managedRuntime.services,
    contract.managedRuntime.services.allowed,
    "managedRuntime.services",
  );
  assertExact(
    report.managedRuntime.processes,
    contract.managedRuntime.processes.exact,
    "managedRuntime.processes",
  );

  const bindingValues = new Map<string, string[]>();
  const bindingSeen = new Map<string, Set<string>>();
  for (const app of report.apps) {
    if (!Object.hasOwn(contract.apps.mappings, app)) {
      fail(`selected app '${app}' has no contract mapping.`);
    }
    const mapping = contract.apps.mappings[app];
    if (!mapping) fail(`selected app '${app}' has no contract mapping.`);
    for (const key of Object.keys(mapping.bindings).sort()) {
      const values = bindingValues.get(key) ?? [];
      const seen = bindingSeen.get(key) ?? new Set<string>();
      for (const value of mapping.bindings[key] ?? []) {
        if (seen.has(value)) continue;
        values.push(value);
        seen.add(value);
      }
      bindingValues.set(key, values);
      bindingSeen.set(key, seen);
    }
  }

  const bindings = Object.fromEntries(
    Array.from(bindingValues.keys())
      .sort()
      .map((key) => [key, bindingValues.get(key) ?? []]),
  );
  return { ...report, contractPath, bindings };
}

function loadContract(
  repoPath: string,
  contractPath: string,
): { contract: ProfilePlanContract; contractPath: string } {
  if (path.isAbsolute(contractPath)) {
    fail("profile plan contract path must be relative to the repository.");
  }
  const absolutePath = assertPathWithinRepo(contractPath, repoPath, "Profile plan contract");
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(absolutePath);
  } catch (error) {
    fail(`could not inspect profile plan contract '${contractPath}': ${(error as Error).message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`profile plan contract '${contractPath}' must be a regular file, not a symlink.`);
  }
  if (metadata.size > MAX_CONTRACT_BYTES) {
    fail(`profile plan contract exceeds the ${MAX_CONTRACT_BYTES}-byte limit.`);
  }

  const realRepo = fs.realpathSync(repoPath);
  const realContract = fs.realpathSync(absolutePath);
  assertPathWithinRepo(realContract, realRepo, "Profile plan contract");
  const source = fs.readFileSync(absolutePath, "utf-8");
  if (Buffer.byteLength(source, "utf-8") > MAX_CONTRACT_BYTES) {
    fail(`profile plan contract exceeds the ${MAX_CONTRACT_BYTES}-byte limit.`);
  }
  return {
    contract: parseProfilePlanContract(source),
    contractPath: path.relative(repoPath, absolutePath).split(path.sep).join("/"),
  };
}

export function resolveProfilePlan(options: {
  repo?: string;
  profile?: string;
  contract: string;
}): ProfilePlanReport {
  const repoPath = resolveRepoPath(options.repo);
  const config = loadRepoConfig(repoPath);
  const loaded = loadContract(repoPath, options.contract);
  return buildProfilePlanReport({
    report: buildProfileResolutionReport(config, repoPath, options.profile),
    contract: loaded.contract,
    registry: registryFor(config),
    contractPath: loaded.contractPath,
  });
}
