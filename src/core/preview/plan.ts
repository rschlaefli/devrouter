import type { DevrouterConfig } from "../../types";
import { buildProfileResolutionReport } from "../profile-resolution";
import type { PreviewManifest, PreviewPlanReport, PreviewSource } from "./types";

const MAX_SOURCE_CHANGES = 10_000;
const MAX_SOURCE_PATH_LENGTH = 4096;
const MAX_SOURCE_PATH_BYTES = 4 * 1024 * 1024;
const MAX_DIGEST_LENGTH = 256;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_STATUSES = new Set(["A", "M", "D", "R", "C", "T"]);
const DEPLOYED_CONTROL_PATHS = [
  ".devrouter.yml",
  ".devrouter.preview.yml",
  ".gitlab-ci.yml",
  ".github/workflows/**",
  "ci/**",
];

type Resource = PreviewManifest["resources"][string];
type BindingSection = keyof PreviewManifest["bindings"];
type SelectionResult =
  | { status: "planned"; aliases: string[]; reasons: string[] }
  | { status: "no-runtime"; aliases: []; reasons: string[] }
  | { status: "selection-required"; aliases: []; reasons: string[] }
  | { status: "review-required"; aliases: []; reasons: string[] }
  | { status: "unknown"; aliases: []; reasons: string[] };

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
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

function readDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DIGEST_LENGTH) {
    fail(`${label} must be a non-empty bounded string.`);
  }
  if (value.trim() !== value || /\s/.test(value)) fail(`${label} must not contain whitespace.`);
  return value;
}

function readRepoPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE_PATH_LENGTH) {
    fail(`${label} must be a bounded non-empty repository-relative path.`);
  }
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.endsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    hasControlCharacters(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label} must be a normalized repository-relative path.`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function validateSource(value: PreviewSource): PreviewSource {
  const source = requireRecord(value, "source");
  requireFields(source, ["head", "target", "mergeBase", "complete", "changes"], [], "source");
  for (const key of ["head", "target", "mergeBase"] as const) {
    if (typeof source[key] !== "string" || !SHA_RE.test(source[key])) {
      fail(`source.${key} must be a 40- or 64-character lowercase hexadecimal SHA.`);
    }
  }
  if (typeof source.complete !== "boolean") fail("source.complete must be a boolean.");
  if (!Array.isArray(source.changes)) fail("source.changes must be an array.");
  if (source.changes.length > MAX_SOURCE_CHANGES) {
    fail(`source.changes exceeds the ${MAX_SOURCE_CHANGES}-entry limit.`);
  }

  let totalPathBytes = 0;
  const seen = new Set<string>();
  const changes = source.changes.map((rawChange, index) => {
    const label = `source.changes[${index}]`;
    const change = requireRecord(rawChange, label);
    requireFields(change, ["status", "path"], ["oldPath"], label);
    if (typeof change.status !== "string" || !CHANGE_STATUSES.has(change.status)) {
      fail(`${label}.status is unsupported.`);
    }
    const status = change.status as PreviewSource["changes"][number]["status"];
    const currentPath = readRepoPath(change.path, `${label}.path`);
    totalPathBytes += Buffer.byteLength(currentPath, "utf-8");
    const oldPath =
      change.oldPath === undefined ? undefined : readRepoPath(change.oldPath, `${label}.oldPath`);
    if (oldPath !== undefined) totalPathBytes += Buffer.byteLength(oldPath, "utf-8");
    if (status === "R" || status === "C") {
      if (oldPath === undefined) fail(`${label}.oldPath is required for ${status} changes.`);
    } else if (oldPath !== undefined) {
      fail(`${label}.oldPath is only valid for R or C changes.`);
    }
    const key = `${status}\0${currentPath}\0${oldPath ?? ""}`;
    if (seen.has(key)) fail("source.changes must not contain duplicate entries.");
    seen.add(key);
    return {
      status,
      path: currentPath,
      ...(oldPath === undefined ? {} : { oldPath }),
    };
  });
  if (totalPathBytes > MAX_SOURCE_PATH_BYTES) {
    fail(`source.changes path metadata exceeds the ${MAX_SOURCE_PATH_BYTES}-byte limit.`);
  }

  return {
    head: source.head as string,
    target: source.target as string,
    mergeBase: source.mergeBase as string,
    complete: source.complete,
    changes,
  };
}

function escapeRegExp(character: string): string {
  return "\\.^$*+?()[]{}|".includes(character) ? `\\${character}` : character;
}

function globMatches(pattern: string, repoPath: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        expression += "(?:.*/)?";
        index += 1;
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character ?? "");
    }
  }
  return new RegExp(`${expression}$`).test(repoPath);
}

function matchesAny(patterns: string[], repoPath: string): boolean {
  return patterns.some((pattern) => globMatches(pattern, repoPath));
}

function changePaths(change: PreviewSource["changes"][number]): string[] {
  return Array.from(new Set([change.path, ...(change.oldPath ? [change.oldPath] : [])])).sort();
}

function controlChanges(manifest: PreviewManifest, source: PreviewSource): string[] {
  const patterns = [...DEPLOYED_CONTROL_PATHS, ...manifest.selection.controlPaths];
  const matches = new Set<string>();
  for (const change of source.changes) {
    for (const repoPath of changePaths(change)) {
      if (matchesAny(patterns, repoPath)) matches.add(repoPath);
    }
  }
  return [...matches].sort();
}

function selectionReasons(prefix: string, values: string[]): string[] {
  return values.map((value) => `${prefix}:${value}`);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function sameAliasSet(left: string[], right: string[]): boolean {
  const canonicalLeft = uniqueSorted(left);
  const canonicalRight = uniqueSorted(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}

function assertAllowedUnion(manifest: PreviewManifest, aliases: string[]): void {
  if (aliases.length < 2) return;
  if (!manifest.selection.allowedUnions.some((union) => sameAliasSet(union, aliases))) {
    fail(`preview alias union [${uniqueSorted(aliases).join(", ")}] is not allowed.`);
  }
}

function automaticSelection(
  manifest: PreviewManifest,
  source: PreviewSource | undefined,
): SelectionResult {
  if (!source) return { status: "unknown", aliases: [], reasons: ["source-missing"] };
  if (!source.complete) {
    return { status: "unknown", aliases: [], reasons: ["source-incomplete"] };
  }
  const controls = controlChanges(manifest, source);
  if (controls.length > 0) {
    return {
      status: "review-required",
      aliases: [],
      reasons: selectionReasons("control-file-changed", controls),
    };
  }

  let hasRuntimePath = false;
  const unmatched = new Set<string>();
  const aliases = new Set<string>();
  for (const change of source.changes) {
    for (const repoPath of changePaths(change)) {
      if (matchesAny(manifest.selection.ignorePaths, repoPath)) continue;
      hasRuntimePath = true;
      let matched = false;
      for (const rule of manifest.selection.rules) {
        if (!matchesAny(rule.paths, repoPath)) continue;
        matched = true;
        for (const alias of rule.aliases) aliases.add(alias);
      }
      if (!matched) unmatched.add(repoPath);
    }
  }

  if (!hasRuntimePath) {
    return {
      status: "no-runtime",
      aliases: [],
      reasons: [source.changes.length === 0 ? "no-changes" : "changes-ignored"],
    };
  }
  if (unmatched.size > 0) {
    if (!manifest.selection.fallback) {
      return {
        status: "selection-required",
        aliases: [],
        reasons: selectionReasons("unmatched-path", [...unmatched].sort()),
      };
    }
    aliases.add(manifest.selection.fallback);
  }
  let selected = uniqueSorted(aliases);
  if (selected.length === 0) {
    return { status: "selection-required", aliases: [], reasons: ["no-alias-rule"] };
  }
  if (
    selected.length > 1 &&
    manifest.selection.dominating &&
    selected.includes(manifest.selection.dominating)
  ) {
    selected = [manifest.selection.dominating];
  }
  assertAllowedUnion(manifest, selected);
  return { status: "planned", aliases: selected, reasons: [] };
}

function readAliases(
  manifest: PreviewManifest,
  aliases: string[] | undefined,
  source: PreviewSource | undefined,
): SelectionResult {
  if (aliases === undefined) return automaticSelection(manifest, source);
  if (!Array.isArray(aliases) || aliases.length === 0) {
    fail("aliases must be a non-empty array when provided.");
  }
  const selected = uniqueSorted(aliases);
  if (selected.length !== aliases.length) fail("aliases must not contain duplicates.");
  for (const alias of selected) {
    if (typeof alias !== "string" || !Object.hasOwn(manifest.aliases, alias)) {
      fail(`preview alias '${String(alias)}' is not defined.`);
    }
  }
  assertAllowedUnion(manifest, selected);
  if (!source) {
    return { status: "planned", aliases: selected, reasons: ["source-unbound"] };
  }
  if (!source.complete) {
    return { status: "unknown", aliases: [], reasons: ["source-incomplete"] };
  }
  const controls = controlChanges(manifest, source);
  if (controls.length > 0) {
    return {
      status: "review-required",
      aliases: [],
      reasons: selectionReasons("control-file-changed", controls),
    };
  }
  return { status: "planned", aliases: selected, reasons: [] };
}

function aliasResources(manifest: PreviewManifest, alias: string): string[] {
  const entry = manifest.aliases[alias];
  if (!entry) fail(`preview alias '${alias}' is not defined.`);
  if ("resources" in entry) return entry.resources;
  return [];
}

function aliasProfiles(manifest: PreviewManifest, alias: string): string[] {
  const entry = manifest.aliases[alias];
  if (!entry) fail(`preview alias '${alias}' is not defined.`);
  if ("profiles" in entry) return entry.profiles;
  return [];
}

function addBinding(
  manifest: PreviewManifest,
  section: BindingSection,
  logicalName: string,
  selected: Set<string>,
  omissions: Set<string>,
): void {
  const mappings = manifest.bindings[section];
  if (!Object.hasOwn(mappings, logicalName)) {
    fail(`selected ${section} '${logicalName}' has no preview binding.`);
  }
  const resources = mappings[logicalName] ?? [];
  if (resources.length === 0) {
    omissions.add(`bindings.${section}.${logicalName}`);
    return;
  }
  for (const resource of resources) {
    if (!Object.hasOwn(manifest.resources, resource)) {
      fail(`bindings.${section}.${logicalName} references unknown resource '${resource}'.`);
    }
    selected.add(resource);
  }
}

function orderedResourceClosure(
  manifest: PreviewManifest,
  initial: Iterable<string>,
): Array<Resource & { id: string }> {
  const ordered: string[] = [];
  const completed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (completed.has(id)) return;
    if (visiting.has(id)) fail(`selected preview resources contain a dependency cycle at '${id}'.`);
    const resource = manifest.resources[id];
    if (!resource) fail(`selected preview resource '${id}' is not defined.`);
    visiting.add(id);
    for (const dependency of [...(resource.dependsOn ?? [])].sort()) visit(dependency);
    visiting.delete(id);
    completed.add(id);
    ordered.push(id);
  };
  for (const id of uniqueSorted(initial)) visit(id);
  return ordered.map((id) => {
    const resource = manifest.resources[id];
    if (!resource) fail(`selected preview resource '${id}' is not defined.`);
    return { id, ...resource };
  });
}

function plannedResources(
  options: {
    repoPath: string;
    config: DevrouterConfig;
    manifest: PreviewManifest;
  },
  aliases: string[],
): {
  resources: Array<Resource & { id: string }>;
  profiles?: string[];
  omissions: string[];
} {
  const selectedResources = new Set<string>();
  const omissions = new Set<string>();
  const profiles = uniqueSorted(aliases.flatMap((alias) => aliasProfiles(options.manifest, alias)));
  for (const alias of aliases) {
    for (const resource of aliasResources(options.manifest, alias)) selectedResources.add(resource);
  }

  if (profiles.length > 0) {
    const report = buildProfileResolutionReport(
      options.config,
      options.repoPath,
      profiles.join(","),
    );
    for (const app of uniqueSorted(report.apps)) {
      addBinding(options.manifest, "apps", app, selectedResources, omissions);
    }
    for (const dependency of uniqueSorted(report.dependencies)) {
      addBinding(options.manifest, "dependencies", dependency, selectedResources, omissions);
    }
    for (const service of uniqueSorted(report.managedRuntime.services)) {
      addBinding(options.manifest, "services", service, selectedResources, omissions);
    }
    for (const process of uniqueSorted(report.managedRuntime.processes)) {
      addBinding(options.manifest, "processes", process, selectedResources, omissions);
    }
  }

  return {
    resources: orderedResourceClosure(options.manifest, selectedResources),
    ...(profiles.length > 0 ? { profiles } : {}),
    omissions: [...omissions].sort(),
  };
}

export function listPreviewAliases(manifest: PreviewManifest): string[] {
  return Object.keys(manifest.aliases).sort();
}

export function buildPreviewPlan(options: {
  repoPath: string;
  config: DevrouterConfig;
  manifest: PreviewManifest;
  manifestDigest: string;
  localConfigDigest: string;
  aliases?: string[];
  source?: PreviewSource;
}): PreviewPlanReport {
  const manifestDigest = readDigest(options.manifestDigest, "manifestDigest");
  const localConfigDigest = readDigest(options.localConfigDigest, "localConfigDigest");
  const source = options.source === undefined ? undefined : validateSource(options.source);
  const selection = readAliases(options.manifest, options.aliases, source);
  const selectedProfiles = uniqueSorted(
    selection.aliases.flatMap((alias) => aliasProfiles(options.manifest, alias)),
  );
  const common = {
    schemaVersion: 1 as const,
    aliases: selection.aliases,
    ...(selectedProfiles.length > 0 ? { profiles: selectedProfiles } : {}),
    reasons: selection.reasons,
    manifestDigest,
    localConfigDigest,
    ...(source ? { source } : {}),
  };

  if (selection.status !== "planned") {
    return { ...common, status: selection.status, resources: [], omissions: [] };
  }
  const planned = plannedResources(options, selection.aliases);
  return {
    ...common,
    status: "planned",
    resources: planned.resources,
    omissions: planned.omissions,
  };
}
