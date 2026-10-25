import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { assertPathWithinRepo } from "../paths";
import type { PreviewManifest } from "./types";

const MANIFEST_FILE_NAME = ".devrouter.preview.yml";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COLLECTION_ENTRIES = 256;
const MAX_BINDING_VALUES = 4096;
const MAX_COMMAND_ARGS = 128;
const MAX_LITERAL_LENGTH = 4096;
const MAX_REPO_PATH_LENGTH = 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[0-9a-f]{64})?$/;

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

function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${label} has unsupported keys: ${unknown.sort().join(", ")}.`);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label} is missing keys: ${missing.join(", ")}.`);
}

function readText(value: unknown, label: string, maxLength = MAX_LITERAL_LENGTH): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    fail(`${label} exceeds the ${maxLength}-character limit.`);
  }
  if (value.includes("\0")) fail(`${label} must not contain NUL characters.`);
  return value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function readName(value: unknown, label: string): string {
  const name = readText(value, label, 63);
  if (!NAME_RE.test(name)) {
    fail(`${label} must be 1-63 lowercase alphanumeric or hyphen-separated characters.`);
  }
  return name;
}

function readStringArray(
  value: unknown,
  label: string,
  read: (entry: unknown, label: string) => string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (!options.allowEmpty && value.length === 0) fail(`${label} must not be empty.`);
  if (value.length > MAX_COLLECTION_ENTRIES) {
    fail(`${label} exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
  }
  const entries = value.map((entry, index) => read(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) fail(`${label} must not contain duplicates.`);
  return entries;
}

function readNameArray(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  return readStringArray(value, label, readName, options);
}

function assertRepoRelativePath(value: unknown, label: string, allowDot = false): string {
  const repoPath = readText(value, label, MAX_REPO_PATH_LENGTH);
  if (
    repoPath.startsWith("/") ||
    repoPath.includes("\\") ||
    repoPath.includes("//") ||
    repoPath.endsWith("/") ||
    /^[A-Za-z]:/.test(repoPath)
  ) {
    fail(`${label} must be a normalized repository-relative path.`);
  }
  if (hasControlCharacters(repoPath)) {
    fail(`${label} must not contain control characters.`);
  }
  if (repoPath === ".") {
    if (allowDot) return repoPath;
    fail(`${label} must name a file.`);
  }
  if (
    repoPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label} must be a normalized repository-relative path.`);
  }
  return repoPath;
}

function readPattern(value: unknown, label: string): string {
  const pattern = readText(value, label, MAX_REPO_PATH_LENGTH);
  if (
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    pattern.includes("//") ||
    pattern.endsWith("/") ||
    /^[A-Za-z]:/.test(pattern)
  ) {
    fail(`${label} must be a normalized repository-relative glob.`);
  }
  if (hasControlCharacters(pattern)) {
    fail(`${label} must not contain control characters.`);
  }
  if (pattern.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} must be a normalized repository-relative glob.`);
  }
  return pattern;
}

function readImage(value: unknown, label: string): string {
  const image = readText(value, label, 1024);
  if (!IMAGE_REFERENCE_RE.test(image)) {
    fail(`${label} must be an image reference without URL credentials.`);
  }
  return image;
}

function readCommand(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length === 0) fail(`${label} must not be empty.`);
  if (value.length > MAX_COMMAND_ARGS) {
    fail(`${label} exceeds the ${MAX_COMMAND_ARGS}-argument limit.`);
  }
  // Command order and repeated arguments are semantic; uniqueness applies to
  // identifiers, references, paths and patterns rather than argv tokens.
  return value.map((entry, index) => readText(entry, `${label}[${index}]`));
}

function readPort(
  value: unknown,
  label: string,
): NonNullable<PreviewManifest["resources"][string]["ports"]>[number] {
  const port = requireRecord(value, label);
  requireFields(port, ["name", "port", "public"], [], label);
  if (!Number.isInteger(port.port) || (port.port as number) < 1 || (port.port as number) > 65535) {
    fail(`${label}.port must be an integer from 1 to 65535.`);
  }
  if (typeof port.public !== "boolean") fail(`${label}.public must be a boolean.`);
  return {
    name: readName(port.name, `${label}.name`),
    port: port.port as number,
    public: port.public,
  };
}

function readBuild(
  value: unknown,
  label: string,
): NonNullable<PreviewManifest["resources"][string]["build"]> {
  const build = requireRecord(value, label);
  requireFields(build, ["context", "dockerfile"], ["target"], label);
  return {
    context: assertRepoRelativePath(build.context, `${label}.context`, true),
    dockerfile: assertRepoRelativePath(build.dockerfile, `${label}.dockerfile`),
    ...(build.target === undefined
      ? {}
      : { target: readText(build.target, `${label}.target`, 255) }),
  };
}

function parseResources(value: unknown): PreviewManifest["resources"] {
  const input = requireRecord(value, "resources");
  if (Object.keys(input).length > MAX_COLLECTION_ENTRIES) {
    fail(`resources exceeds the ${MAX_COLLECTION_ENTRIES}-resource limit.`);
  }
  const resources: Array<[string, PreviewManifest["resources"][string]]> = [];
  for (const [rawId, rawDefinition] of Object.entries(input)) {
    const id = readName(rawId, `resources.${rawId}`);
    const definition = requireRecord(rawDefinition, `resources.${id}`);
    const kind = definition.kind;
    if (
      kind !== "service" &&
      kind !== "job" &&
      kind !== "postgres" &&
      kind !== "redis" &&
      kind !== "volume"
    ) {
      fail(`resources.${id}.kind is unsupported.`);
    }
    const resourceKind = kind as PreviewManifest["resources"][string]["kind"];

    const isContainer = resourceKind === "service" || resourceKind === "job";
    requireFields(
      definition,
      ["kind"],
      isContainer ? ["image", "build", "dependsOn", "ports", "command"] : ["dependsOn"],
      `resources.${id}`,
    );

    const dependsOn =
      definition.dependsOn === undefined
        ? undefined
        : readNameArray(definition.dependsOn, `resources.${id}.dependsOn`, { allowEmpty: true });
    const common = { kind: resourceKind, ...(dependsOn ? { dependsOn } : {}) };
    if (!isContainer) {
      resources.push([id, common]);
      continue;
    }

    const hasImage = Object.hasOwn(definition, "image") && definition.image !== undefined;
    const hasBuild = Object.hasOwn(definition, "build") && definition.build !== undefined;
    if (hasImage === hasBuild) {
      fail(`resources.${id} must define exactly one of image or build.`);
    }

    let ports: NonNullable<PreviewManifest["resources"][string]["ports"]> | undefined;
    if (definition.ports !== undefined) {
      const rawPorts = definition.ports;
      if (!Array.isArray(rawPorts)) fail(`resources.${id}.ports must be an array.`);
      if (rawPorts.length > MAX_COLLECTION_ENTRIES) {
        fail(`resources.${id}.ports exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
      }
      ports = rawPorts.map((entry, index) => readPort(entry, `resources.${id}.ports[${index}]`));
      if (new Set(ports.map((entry) => entry.name)).size !== ports.length) {
        fail(`resources.${id}.ports must have unique names.`);
      }
    }

    resources.push([
      id,
      {
        ...common,
        ...(hasImage ? { image: readImage(definition.image, `resources.${id}.image`) } : {}),
        ...(hasBuild ? { build: readBuild(definition.build, `resources.${id}.build`) } : {}),
        ...(ports ? { ports } : {}),
        ...(definition.command === undefined
          ? {}
          : { command: readCommand(definition.command, `resources.${id}.command`) }),
      },
    ]);
  }
  return Object.fromEntries(resources);
}

function parseAliases(
  value: unknown,
  resources: PreviewManifest["resources"],
): PreviewManifest["aliases"] {
  const input = requireRecord(value, "aliases");
  if (Object.keys(input).length > MAX_COLLECTION_ENTRIES) {
    fail(`aliases exceeds the ${MAX_COLLECTION_ENTRIES}-alias limit.`);
  }
  const aliases: Array<[string, PreviewManifest["aliases"][string]]> = [];
  for (const [rawName, rawAlias] of Object.entries(input)) {
    const name = readName(rawName, `aliases.${rawName}`);
    const alias = requireRecord(rawAlias, `aliases.${name}`);
    const hasProfiles = Object.hasOwn(alias, "profiles");
    const hasResources = Object.hasOwn(alias, "resources");
    if (hasProfiles === hasResources) {
      fail(`aliases.${name} must define exactly one of profiles or resources.`);
    }
    if (hasProfiles) {
      requireFields(alias, ["profiles"], [], `aliases.${name}`);
      aliases.push([name, { profiles: readNameArray(alias.profiles, `aliases.${name}.profiles`) }]);
      continue;
    }
    requireFields(alias, ["resources"], [], `aliases.${name}`);
    const selected = readNameArray(alias.resources, `aliases.${name}.resources`);
    for (const resource of selected) {
      if (!Object.hasOwn(resources, resource)) {
        fail(`aliases.${name}.resources references unknown resource '${resource}'.`);
      }
    }
    aliases.push([name, { resources: selected }]);
  }
  return Object.fromEntries(aliases);
}

function parseBindings(
  value: unknown,
  resources: PreviewManifest["resources"],
): PreviewManifest["bindings"] {
  const input = requireRecord(value, "bindings");
  requireFields(input, ["apps", "dependencies", "services", "processes"], [], "bindings");
  let totalValues = 0;
  const parseSection = (key: keyof PreviewManifest["bindings"]): Record<string, string[]> => {
    const section = requireRecord(input[key], `bindings.${key}`);
    if (Object.keys(section).length > MAX_COLLECTION_ENTRIES) {
      fail(`bindings.${key} exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
    }
    const mappings: Array<[string, string[]]> = [];
    for (const [rawLogicalName, rawResources] of Object.entries(section)) {
      const logicalName = readName(rawLogicalName, `bindings.${key}.${rawLogicalName}`);
      const mapped = readNameArray(rawResources, `bindings.${key}.${logicalName}`, {
        allowEmpty: true,
      });
      for (const resource of mapped) {
        if (!Object.hasOwn(resources, resource)) {
          fail(`bindings.${key}.${logicalName} references unknown resource '${resource}'.`);
        }
      }
      totalValues += mapped.length;
      mappings.push([logicalName, mapped]);
    }
    return Object.fromEntries(mappings);
  };

  const bindings = {
    apps: parseSection("apps"),
    dependencies: parseSection("dependencies"),
    services: parseSection("services"),
    processes: parseSection("processes"),
  };
  if (totalValues > MAX_BINDING_VALUES) {
    fail(`bindings exceeds the ${MAX_BINDING_VALUES}-value limit.`);
  }
  return bindings;
}

function assertKnownAlias(aliases: PreviewManifest["aliases"], name: string, label: string): void {
  if (!Object.hasOwn(aliases, name)) fail(`${label} references unknown alias '${name}'.`);
}

function parseSelection(
  value: unknown,
  aliases: PreviewManifest["aliases"],
): PreviewManifest["selection"] {
  const input = requireRecord(value, "selection");
  requireFields(
    input,
    ["rules", "ignorePaths", "controlPaths", "allowedUnions"],
    ["fallback", "dominating"],
    "selection",
  );
  if (!Array.isArray(input.rules)) fail("selection.rules must be an array.");
  if (input.rules.length > MAX_COLLECTION_ENTRIES) {
    fail(`selection.rules exceeds the ${MAX_COLLECTION_ENTRIES}-rule limit.`);
  }
  const rules = input.rules.map((rawRule, index) => {
    const label = `selection.rules[${index}]`;
    const rule = requireRecord(rawRule, label);
    requireFields(rule, ["paths", "aliases"], [], label);
    const paths = readStringArray(rule.paths, `${label}.paths`, readPattern);
    const selected = readNameArray(rule.aliases, `${label}.aliases`);
    for (const alias of selected) assertKnownAlias(aliases, alias, `${label}.aliases`);
    return { paths, aliases: selected };
  });

  const ignorePaths = readStringArray(input.ignorePaths, "selection.ignorePaths", readPattern, {
    allowEmpty: true,
  });
  const controlPaths = readStringArray(input.controlPaths, "selection.controlPaths", readPattern, {
    allowEmpty: true,
  });
  if (!Array.isArray(input.allowedUnions)) {
    fail("selection.allowedUnions must be an array.");
  }
  if (input.allowedUnions.length > MAX_COLLECTION_ENTRIES) {
    fail(`selection.allowedUnions exceeds the ${MAX_COLLECTION_ENTRIES}-entry limit.`);
  }
  const allowedUnions = input.allowedUnions.map((rawUnion, index) => {
    const label = `selection.allowedUnions[${index}]`;
    const union = readNameArray(rawUnion, label);
    if (union.length < 2) fail(`${label} must contain at least two aliases.`);
    for (const alias of union) assertKnownAlias(aliases, alias, label);
    return union;
  });
  const unionKeys = allowedUnions.map((union) => [...union].sort().join("\0"));
  if (new Set(unionKeys).size !== unionKeys.length) {
    fail("selection.allowedUnions must not contain duplicate unions.");
  }
  const allowedKeys = new Set(unionKeys);
  for (const [index, rule] of rules.entries()) {
    if (rule.aliases.length > 1) {
      const key = [...rule.aliases].sort().join("\0");
      if (!allowedKeys.has(key)) {
        fail(`selection.rules[${index}] alias union is not listed in selection.allowedUnions.`);
      }
    }
  }

  for (const key of ["fallback", "dominating"] as const) {
    if (input[key] !== undefined) {
      assertKnownAlias(aliases, readName(input[key], `selection.${key}`), `selection.${key}`);
    }
  }
  return {
    rules,
    ignorePaths,
    controlPaths,
    ...(input.fallback === undefined
      ? {}
      : { fallback: readName(input.fallback, "selection.fallback") }),
    ...(input.dominating === undefined
      ? {}
      : { dominating: readName(input.dominating, "selection.dominating") }),
    allowedUnions,
  };
}

function assertResourceGraph(resources: PreviewManifest["resources"]): void {
  for (const [id, resource] of Object.entries(resources)) {
    for (const dependency of resource.dependsOn ?? []) {
      if (!Object.hasOwn(resources, dependency)) {
        fail(`resources.${id}.dependsOn references unknown resource '${dependency}'.`);
      }
    }
  }

  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const state = states.get(id);
    if (state === "visited") return;
    if (state === "visiting") {
      const start = stack.indexOf(id);
      fail(`resources contains a dependency cycle: ${[...stack.slice(start), id].join(" -> ")}`);
    }
    states.set(id, "visiting");
    stack.push(id);
    for (const dependency of [...(resources[id]?.dependsOn ?? [])].sort()) visit(dependency);
    stack.pop();
    states.set(id, "visited");
  };
  for (const id of Object.keys(resources).sort()) visit(id);
}

export function parsePreviewManifest(source: string): PreviewManifest {
  const document = parseDocument(source, {
    merge: false,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(`preview manifest is invalid YAML: ${document.errors[0]?.message}`);
  }
  if (document.warnings.length > 0) {
    fail(`preview manifest has unsupported YAML: ${document.warnings[0]?.message}`);
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    fail(`preview manifest could not be converted: ${(error as Error).message}`);
  }
  const root = requireRecord(raw, "preview manifest");
  requireFields(
    root,
    ["version", "aliases", "bindings", "resources", "selection"],
    [],
    "preview manifest",
  );
  if (root.version !== 1) fail(`unsupported preview manifest version ${String(root.version)}.`);

  const resources = parseResources(root.resources);
  const aliases = parseAliases(root.aliases, resources);
  const bindings = parseBindings(root.bindings, resources);
  const selection = parseSelection(root.selection, aliases);
  assertResourceGraph(resources);

  return { version: 1, aliases, bindings, resources, selection };
}

export function loadPreviewManifest(repoPath: string): {
  manifest: PreviewManifest;
  digest: string;
} {
  const resolvedRepo = path.resolve(repoPath);
  const manifestPath = assertPathWithinRepo(MANIFEST_FILE_NAME, resolvedRepo, "Preview manifest");
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(manifestPath);
  } catch (error) {
    fail(`could not inspect preview manifest '${MANIFEST_FILE_NAME}': ${(error as Error).message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`preview manifest '${MANIFEST_FILE_NAME}' must be a regular file, not a symlink.`);
  }
  if (metadata.size > MAX_MANIFEST_BYTES) {
    fail(`preview manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
  }

  const realRepo = fs.realpathSync(resolvedRepo);
  const realManifest = fs.realpathSync(manifestPath);
  assertPathWithinRepo(realManifest, realRepo, "Preview manifest");
  const source = fs.readFileSync(manifestPath, "utf-8");
  if (Buffer.byteLength(source, "utf-8") > MAX_MANIFEST_BYTES) {
    fail(`preview manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
  }
  return {
    manifest: parsePreviewManifest(source),
    digest: createHash("sha256").update(source, "utf-8").digest("hex"),
  };
}
