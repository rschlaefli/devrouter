import fs from "node:fs";
import path from "node:path";
import {
  asStringList,
  isMapping,
  type KnowledgeValidationContext,
  reportFinding,
} from "./knowledge-validator-context";
import { type KnowledgeDocument, parseYamlMapping } from "./knowledge-validator-core";
import { validateSourcePaths } from "./knowledge-validator-hygiene";

interface KnowledgeProfile {
  requiredFields: string[];
  allowedTypes: string[];
  allowedStatuses: string[];
  conceptPaths: Set<string>;
  highConsequenceConcepts: Set<string>;
}

export function loadKnowledgeProfile(
  context: KnowledgeValidationContext,
): KnowledgeProfile | undefined {
  if (!fs.existsSync(context.profilePath)) {
    reportFinding(
      context,
      "profile",
      "PROFILE_FILE",
      context.profilePath,
      "profile file does not exist",
    );
    return undefined;
  }

  const parsed = parseYamlMapping(
    context,
    fs.readFileSync(context.profilePath, "utf8"),
    context.profilePath,
    "profile",
    "PROFILE_YAML",
  );
  if (!parsed) return undefined;

  let validSchema = true;
  if (parsed.version !== 1) {
    reportFinding(context, "profile", "PROFILE_SCHEMA", context.profilePath, "version must be 1");
    validSchema = false;
  }

  const expectedBundle = path
    .relative(context.repoRoot, context.bundleRoot)
    .split(path.sep)
    .join("/");
  if (parsed.bundle !== expectedBundle) {
    reportFinding(
      context,
      "profile",
      "PROFILE_SCHEMA",
      context.profilePath,
      `bundle must be ${expectedBundle}`,
    );
    validSchema = false;
  }

  const requiredFields = asStringList(parsed.required_fields);
  if (!requiredFields) {
    reportFinding(
      context,
      "profile",
      "PROFILE_SCHEMA",
      context.profilePath,
      "required_fields must be a non-empty string list",
    );
    validSchema = false;
  }

  const allowedTypes = asStringList(parsed.allowed_types);
  if (!allowedTypes) {
    reportFinding(
      context,
      "profile",
      "PROFILE_SCHEMA",
      context.profilePath,
      "allowed_types must be a non-empty string list",
    );
    validSchema = false;
  }

  const allowedStatuses = asStringList(parsed.allowed_statuses);
  if (!allowedStatuses) {
    reportFinding(
      context,
      "profile",
      "PROFILE_SCHEMA",
      context.profilePath,
      "allowed_statuses must be a non-empty string list",
    );
    validSchema = false;
  }

  const conceptPaths = new Set<string>();
  const highConsequenceConcepts = new Set<string>();
  if (!isMapping(parsed.concepts) || Object.keys(parsed.concepts).length === 0) {
    reportFinding(
      context,
      "profile",
      "PROFILE_SCHEMA",
      context.profilePath,
      "concepts must be a non-empty mapping",
    );
    validSchema = false;
  } else {
    for (const [conceptPath, settings] of Object.entries(parsed.concepts)) {
      const normalizedPath = path.posix.normalize(conceptPath.replace(/^\.\//, ""));
      conceptPaths.add(normalizedPath);
      if (
        !isMapping(settings) ||
        (settings.high_consequence !== undefined && typeof settings.high_consequence !== "boolean")
      ) {
        reportFinding(
          context,
          "profile",
          "PROFILE_SCHEMA",
          context.profilePath,
          `concept ${conceptPath} high_consequence must be boolean when present`,
        );
        validSchema = false;
      } else if (settings.high_consequence === true) {
        highConsequenceConcepts.add(normalizedPath);
      }
    }
  }

  if (!validSchema || !requiredFields || !allowedTypes || !allowedStatuses) return undefined;
  return {
    requiredFields,
    allowedTypes,
    allowedStatuses,
    conceptPaths,
    highConsequenceConcepts,
  };
}

function validateStringField(
  context: KnowledgeValidationContext,
  document: KnowledgeDocument,
  field: string,
): void {
  const value = document.fields?.[field];
  if (typeof value === "string" && value.trim() !== "") return;
  reportFinding(
    context,
    "profile",
    "PROFILE_REQUIRED_FIELD",
    document.filePath,
    `profile requires a non-empty string ${field} field`,
  );
}

function validateConcept(
  context: KnowledgeValidationContext,
  document: KnowledgeDocument,
  profile: KnowledgeProfile,
): void {
  for (const field of profile.requiredFields) {
    if (field === "source_paths")
      validateSourcePaths(context, document, document.fields?.source_paths);
    else validateStringField(context, document, field);
  }

  const type = document.fields?.type;
  if (typeof type === "string" && !profile.allowedTypes.includes(type)) {
    reportFinding(
      context,
      "profile",
      "PROFILE_TYPE",
      document.filePath,
      `type must be one of: ${profile.allowedTypes.join(", ")}`,
    );
  }

  const status = document.fields?.status;
  if (typeof status === "string" && !profile.allowedStatuses.includes(status)) {
    reportFinding(
      context,
      "profile",
      "PROFILE_STATUS",
      document.filePath,
      `status must be one of: ${profile.allowedStatuses.join(", ")}`,
    );
  }

  const conceptPath = path
    .relative(context.bundleRoot, document.filePath)
    .split(path.sep)
    .join("/");
  const owner = document.fields?.owner;
  if (
    profile.highConsequenceConcepts.has(conceptPath) &&
    (typeof owner !== "string" || owner.trim() === "")
  ) {
    reportFinding(
      context,
      "profile",
      "PROFILE_OWNER",
      document.filePath,
      "high-consequence concept requires a non-empty owner field",
    );
  }
}

export function validateKnowledgeProfile(
  context: KnowledgeValidationContext,
  profile: KnowledgeProfile,
  concepts: KnowledgeDocument[],
): void {
  const conceptsByPath = new Map(
    concepts.map((document) => [
      path.relative(context.bundleRoot, document.filePath).split(path.sep).join("/"),
      document,
    ]),
  );

  for (const conceptPath of profile.conceptPaths) {
    if (
      conceptPath.startsWith("../") ||
      path.posix.isAbsolute(conceptPath) ||
      !conceptsByPath.has(conceptPath)
    ) {
      reportFinding(
        context,
        "profile",
        "PROFILE_CONCEPT_MEMBERSHIP",
        context.profilePath,
        `profile concept does not resolve to an existing non-reserved concept: ${conceptPath}`,
      );
    }
  }

  for (const [conceptPath, document] of conceptsByPath) {
    if (!profile.conceptPaths.has(conceptPath)) {
      reportFinding(
        context,
        "profile",
        "PROFILE_CONCEPT_MEMBERSHIP",
        document.filePath,
        `concept is missing from profile concepts: ${conceptPath}`,
      );
    }
    validateConcept(context, document, profile);
  }
}
