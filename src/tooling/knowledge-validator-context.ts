import path from "node:path";

export type KnowledgeFindingCategory = "core" | "profile" | "hygiene";

export interface KnowledgeFinding {
  category: KnowledgeFindingCategory;
  code: string;
  path: string;
  message: string;
  line?: number;
}

export interface KnowledgeValidationOptions {
  bundleRoot: string;
  profilePath: string;
  repoRoot?: string;
}

export interface KnowledgeValidationReport {
  bundleRoot: string;
  profilePath: string;
  filesScanned: number;
  findings: KnowledgeFinding[];
  valid: boolean;
}

export interface KnowledgeValidationContext {
  repoRoot: string;
  bundleRoot: string;
  profilePath: string;
  findings: KnowledgeFinding[];
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asStringList(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    return undefined;
  }
  return value.map((item) => (item as string).trim());
}

export function relativeToRepo(context: KnowledgeValidationContext, filePath: string): string {
  const relative = path.relative(context.repoRoot, filePath);
  return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : filePath;
}

export function reportFinding(
  context: KnowledgeValidationContext,
  category: KnowledgeFindingCategory,
  code: string,
  filePath: string,
  message: string,
  line?: number,
): void {
  context.findings.push({
    category,
    code,
    path: relativeToRepo(context, filePath),
    message,
    ...(line === undefined ? {} : { line }),
  });
}
