import fs from "node:fs";
import path from "node:path";
import {
  type KnowledgeValidationContext,
  type KnowledgeValidationOptions,
  type KnowledgeValidationReport,
  reportFinding,
} from "./knowledge-validator-context";
import { markdownFiles, parseKnowledgeDocument } from "./knowledge-validator-core";
import { validateKnowledgeHygiene } from "./knowledge-validator-hygiene";
import { loadKnowledgeProfile, validateKnowledgeProfile } from "./knowledge-validator-profile";

export type {
  KnowledgeFinding,
  KnowledgeFindingCategory,
  KnowledgeValidationOptions,
  KnowledgeValidationReport,
} from "./knowledge-validator-context";

export function validateKnowledge(options: KnowledgeValidationOptions): KnowledgeValidationReport {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const context: KnowledgeValidationContext = {
    repoRoot,
    bundleRoot: path.resolve(repoRoot, options.bundleRoot),
    profilePath: path.resolve(repoRoot, options.profilePath),
    findings: [],
  };

  if (!fs.existsSync(context.bundleRoot) || !fs.statSync(context.bundleRoot).isDirectory()) {
    reportFinding(
      context,
      "core",
      "CORE_BUNDLE",
      context.bundleRoot,
      "knowledge bundle is not a directory",
    );
    return {
      bundleRoot: context.bundleRoot,
      profilePath: context.profilePath,
      filesScanned: 0,
      findings: context.findings,
      valid: false,
    };
  }

  const files = markdownFiles(context.bundleRoot);
  const documents = files.map((filePath) => parseKnowledgeDocument(context, filePath));
  const concepts = documents.filter((document) => document.kind === "concept");
  const profile = loadKnowledgeProfile(context);
  if (profile) validateKnowledgeProfile(context, profile, concepts);
  validateKnowledgeHygiene(context, documents);

  return {
    bundleRoot: context.bundleRoot,
    profilePath: context.profilePath,
    filesScanned: files.length,
    findings: context.findings,
    valid: context.findings.length === 0,
  };
}
