import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  isMapping,
  type KnowledgeFindingCategory,
  type KnowledgeValidationContext,
  reportFinding,
} from "./knowledge-validator-context";

export interface KnowledgeDocument {
  filePath: string;
  kind: "concept" | "index" | "log";
  body: string;
  fields?: Record<string, unknown>;
}

interface ParsedFrontmatter {
  fields: Record<string, unknown>;
  body: string;
}

const INDEX_HEADING = /^#\s+\S/m;
const INDEX_LIST_LINK = /^\s*[-*+]\s+\[[^\]]+\]\([^)]+\)/m;
const LOG_DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

export function parseYamlMapping(
  context: KnowledgeValidationContext,
  raw: string,
  filePath: string,
  category: Extract<KnowledgeFindingCategory, "core" | "profile">,
  code: string,
): Record<string, unknown> | undefined {
  const document = YAML.parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length > 0) {
    reportFinding(context, category, code, filePath, `invalid YAML: ${document.errors[0].message}`);
    return undefined;
  }

  const value: unknown = document.toJS();
  if (!isMapping(value)) {
    reportFinding(context, category, code, filePath, "YAML root must be a mapping");
    return undefined;
  }
  return value;
}

function splitFrontmatter(
  context: KnowledgeValidationContext,
  raw: string,
  filePath: string,
): ParsedFrontmatter | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    reportFinding(
      context,
      "core",
      "CORE_FRONTMATTER",
      filePath,
      "concept must begin with YAML frontmatter",
      1,
    );
    return undefined;
  }

  const closingLine = lines.indexOf("---", 1);
  if (closingLine < 0) {
    reportFinding(
      context,
      "core",
      "CORE_FRONTMATTER",
      filePath,
      "frontmatter has no closing '---' delimiter",
      1,
    );
    return undefined;
  }

  const fields = parseYamlMapping(
    context,
    lines.slice(1, closingLine).join("\n"),
    filePath,
    "core",
    "CORE_FRONTMATTER",
  );
  if (!fields) return undefined;
  return { fields, body: lines.slice(closingLine + 1).join("\n") };
}

function hasLeadingFrontmatter(raw: string): boolean {
  return raw === "---" || raw.startsWith("---\n") || raw.startsWith("---\r\n");
}

function validateIndexBody(
  context: KnowledgeValidationContext,
  filePath: string,
  body: string,
): void {
  if (!body.trim()) {
    reportFinding(context, "core", "CORE_INDEX_STRUCTURE", filePath, "index must not be empty");
    return;
  }
  if (!INDEX_HEADING.test(body)) {
    reportFinding(
      context,
      "core",
      "CORE_INDEX_STRUCTURE",
      filePath,
      "index must contain a level-1 heading",
    );
  }
  if (!INDEX_LIST_LINK.test(body)) {
    reportFinding(
      context,
      "core",
      "CORE_INDEX_STRUCTURE",
      filePath,
      "index must contain at least one Markdown list link",
    );
  }
}

function isValidIsoDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function validateLogBody(
  context: KnowledgeValidationContext,
  filePath: string,
  body: string,
): void {
  const dates: string[] = [];
  for (const [lineIndex, line] of body.split(/\r?\n/).entries()) {
    if (!line.startsWith("## ")) continue;
    const match = line.match(LOG_DATE_HEADING);
    if (!match || !isValidIsoDate(match[1])) {
      reportFinding(
        context,
        "core",
        "CORE_LOG_STRUCTURE",
        filePath,
        "level-2 log headings must use a valid `## YYYY-MM-DD` date",
        lineIndex + 1,
      );
      continue;
    }
    dates.push(match[1]);
  }

  if (dates.length === 0) {
    reportFinding(
      context,
      "core",
      "CORE_LOG_STRUCTURE",
      filePath,
      "log must contain at least one `## YYYY-MM-DD` group",
    );
  } else if (dates.some((date, index) => index > 0 && dates[index - 1] < date)) {
    reportFinding(
      context,
      "core",
      "CORE_LOG_STRUCTURE",
      filePath,
      "log date groups must be newest first",
    );
  }
}

function parseReservedDocument(
  context: KnowledgeValidationContext,
  filePath: string,
  raw: string,
  kind: "index" | "log",
): KnowledgeDocument {
  const isRootIndex = filePath === path.join(context.bundleRoot, "index.md");
  if (!isRootIndex) {
    if (hasLeadingFrontmatter(raw)) {
      reportFinding(
        context,
        "core",
        "CORE_RESERVED_FRONTMATTER",
        filePath,
        `${path.basename(filePath)} must not contain frontmatter outside the bundle root index`,
        1,
      );
    }
    if (kind === "index") validateIndexBody(context, filePath, raw);
    else validateLogBody(context, filePath, raw);
    return { filePath, kind, body: raw };
  }

  let body = raw;
  if (hasLeadingFrontmatter(raw)) {
    const parsed = splitFrontmatter(context, raw, filePath);
    if (parsed) {
      body = parsed.body;
      const keys = Object.keys(parsed.fields);
      if (keys.length !== 1 || keys[0] !== "okf_version" || parsed.fields.okf_version !== "0.1") {
        reportFinding(
          context,
          "core",
          "CORE_ROOT_INDEX",
          filePath,
          "root index frontmatter may contain only okf_version 0.1",
        );
      }
    }
  }
  validateIndexBody(context, filePath, body);
  return { filePath, kind, body };
}

export function parseKnowledgeDocument(
  context: KnowledgeValidationContext,
  filePath: string,
): KnowledgeDocument {
  const raw = fs.readFileSync(filePath, "utf8");
  const basename = path.basename(filePath);
  if (basename === "index.md" || basename === "log.md") {
    return parseReservedDocument(context, filePath, raw, basename === "index.md" ? "index" : "log");
  }

  const frontmatter = splitFrontmatter(context, raw, filePath);
  if (!frontmatter) return { filePath, kind: "concept", body: raw };
  if (typeof frontmatter.fields.type !== "string" || frontmatter.fields.type.trim() === "") {
    reportFinding(
      context,
      "core",
      "CORE_TYPE",
      filePath,
      "concept requires a non-empty string type field",
    );
  }
  return {
    filePath,
    kind: "concept",
    body: frontmatter.body,
    fields: frontmatter.fields,
  };
}

export function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
    }
  };
  visit(root);
  return files.sort();
}
