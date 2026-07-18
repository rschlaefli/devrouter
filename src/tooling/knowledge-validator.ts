import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

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

interface ParsedFrontmatter {
  fields: Record<string, unknown>;
  body: string;
}

interface KnowledgeProfile {
  requiredFields: string[];
  allowedTypes: string[];
  allowedStatuses: string[];
  conceptPaths: Set<string>;
  highConsequenceConcepts: Set<string>;
}

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const INDEX_HEADING = /^#\s+\S/m;
const INDEX_LIST_LINK = /^\s*[-*+]\s+\[[^\]]+\]\([^)]+\)/m;
const LOG_DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const REQUIRED_PROFILE_FIELDS = ["type", "title", "description", "status", "source_paths"];

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativeToRepo(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : filePath;
}

function finding(
  category: KnowledgeFindingCategory,
  code: string,
  filePath: string,
  repoRoot: string,
  message: string,
  line?: number,
): KnowledgeFinding {
  return {
    category,
    code,
    path: relativeToRepo(repoRoot, filePath),
    message,
    ...(line === undefined ? {} : { line }),
  };
}

function parseYamlMapping(
  raw: string,
  filePath: string,
  repoRoot: string,
  category: "core" | "profile",
  code: string,
  findings: KnowledgeFinding[],
): Record<string, unknown> | undefined {
  const document = YAML.parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length > 0) {
    findings.push(
      finding(category, code, filePath, repoRoot, `invalid YAML: ${document.errors[0].message}`),
    );
    return undefined;
  }

  const value: unknown = document.toJS();
  if (!isMapping(value)) {
    findings.push(finding(category, code, filePath, repoRoot, "YAML root must be a mapping"));
    return undefined;
  }

  return value;
}

function splitFrontmatter(
  raw: string,
  filePath: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): ParsedFrontmatter | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    findings.push(
      finding(
        "core",
        "CORE_FRONTMATTER",
        filePath,
        repoRoot,
        "concept must begin with YAML frontmatter",
        1,
      ),
    );
    return undefined;
  }

  const closingLine = lines.indexOf("---", 1);
  if (closingLine < 0) {
    findings.push(
      finding(
        "core",
        "CORE_FRONTMATTER",
        filePath,
        repoRoot,
        "frontmatter has no closing `---` delimiter",
        1,
      ),
    );
    return undefined;
  }

  const fields = parseYamlMapping(
    lines.slice(1, closingLine).join("\n"),
    filePath,
    repoRoot,
    "core",
    "CORE_FRONTMATTER",
    findings,
  );
  if (!fields) return undefined;

  return { fields, body: lines.slice(closingLine + 1).join("\n") };
}

function asStringList(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    return undefined;
  }
  return value.map((item) => (item as string).trim());
}

function loadProfile(
  profilePath: string,
  bundleRoot: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): KnowledgeProfile | undefined {
  if (!fs.existsSync(profilePath)) {
    findings.push(
      finding("profile", "PROFILE_FILE", profilePath, repoRoot, "profile file does not exist"),
    );
    return undefined;
  }

  const parsed = parseYamlMapping(
    fs.readFileSync(profilePath, "utf8"),
    profilePath,
    repoRoot,
    "profile",
    "PROFILE_YAML",
    findings,
  );
  if (!parsed) return undefined;

  let validSchema = true;
  if (parsed.version !== 1) {
    findings.push(finding("profile", "PROFILE_SCHEMA", profilePath, repoRoot, "version must be 1"));
    validSchema = false;
  }

  const expectedBundle = path.relative(repoRoot, bundleRoot).split(path.sep).join("/");
  if (parsed.bundle !== expectedBundle) {
    findings.push(
      finding(
        "profile",
        "PROFILE_SCHEMA",
        profilePath,
        repoRoot,
        `bundle must be \`${expectedBundle}\``,
      ),
    );
    validSchema = false;
  }

  const requiredFields = asStringList(parsed.required_fields);
  if (!requiredFields) {
    findings.push(
      finding(
        "profile",
        "PROFILE_SCHEMA",
        profilePath,
        repoRoot,
        "required_fields must be a non-empty string list",
      ),
    );
    validSchema = false;
  } else {
    const missingFields = REQUIRED_PROFILE_FIELDS.filter(
      (field) => !requiredFields.includes(field),
    );
    if (missingFields.length > 0) {
      findings.push(
        finding(
          "profile",
          "PROFILE_SCHEMA",
          profilePath,
          repoRoot,
          `required_fields must include: ${missingFields.join(", ")}`,
        ),
      );
      validSchema = false;
    }
  }

  const allowedTypes = asStringList(parsed.allowed_types);
  if (!allowedTypes) {
    findings.push(
      finding(
        "profile",
        "PROFILE_SCHEMA",
        profilePath,
        repoRoot,
        "allowed_types must be a non-empty string list",
      ),
    );
    validSchema = false;
  }

  const allowedStatuses = asStringList(parsed.allowed_statuses);
  if (!allowedStatuses) {
    findings.push(
      finding(
        "profile",
        "PROFILE_SCHEMA",
        profilePath,
        repoRoot,
        "allowed_statuses must be a non-empty string list",
      ),
    );
    validSchema = false;
  }

  const conceptPaths = new Set<string>();
  const highConsequenceConcepts = new Set<string>();
  if (!isMapping(parsed.concepts) || Object.keys(parsed.concepts).length === 0) {
    findings.push(
      finding(
        "profile",
        "PROFILE_SCHEMA",
        profilePath,
        repoRoot,
        "concepts must be a non-empty mapping",
      ),
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
        findings.push(
          finding(
            "profile",
            "PROFILE_SCHEMA",
            profilePath,
            repoRoot,
            `concept \`${conceptPath}\` high_consequence must be boolean when present`,
          ),
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

function hasLeadingFrontmatter(raw: string): boolean {
  return raw === "---" || raw.startsWith("---\n") || raw.startsWith("---\r\n");
}

function validateIndexBody(
  body: string,
  filePath: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): void {
  if (!body.trim()) {
    findings.push(
      finding("core", "CORE_INDEX_STRUCTURE", filePath, repoRoot, "index must not be empty"),
    );
    return;
  }
  if (!INDEX_HEADING.test(body)) {
    findings.push(
      finding(
        "core",
        "CORE_INDEX_STRUCTURE",
        filePath,
        repoRoot,
        "index must contain a level-1 heading",
      ),
    );
  }
  if (!INDEX_LIST_LINK.test(body)) {
    findings.push(
      finding(
        "core",
        "CORE_INDEX_STRUCTURE",
        filePath,
        repoRoot,
        "index must contain at least one Markdown list link",
      ),
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
  body: string,
  filePath: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): void {
  const dates: string[] = [];
  for (const [lineIndex, line] of body.split(/\r?\n/).entries()) {
    if (!line.startsWith("## ")) continue;
    const match = line.match(LOG_DATE_HEADING);
    if (!match || !isValidIsoDate(match[1])) {
      findings.push(
        finding(
          "core",
          "CORE_LOG_STRUCTURE",
          filePath,
          repoRoot,
          "level-2 log headings must use a valid `## YYYY-MM-DD` date",
          lineIndex + 1,
        ),
      );
      continue;
    }
    dates.push(match[1]);
  }

  if (dates.length === 0) {
    findings.push(
      finding(
        "core",
        "CORE_LOG_STRUCTURE",
        filePath,
        repoRoot,
        "log must contain at least one `## YYYY-MM-DD` group",
      ),
    );
  } else if (dates.some((date, index) => index > 0 && dates[index - 1] < date)) {
    findings.push(
      finding(
        "core",
        "CORE_LOG_STRUCTURE",
        filePath,
        repoRoot,
        "log date groups must be newest first",
      ),
    );
  }
}

function validateReservedFile(
  bundleRoot: string,
  filePath: string,
  raw: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): string {
  const isRootIndex = filePath === path.join(bundleRoot, "index.md");
  if (!isRootIndex) {
    if (hasLeadingFrontmatter(raw)) {
      findings.push(
        finding(
          "core",
          "CORE_RESERVED_FRONTMATTER",
          filePath,
          repoRoot,
          `${path.basename(filePath)} must not contain frontmatter outside the bundle root index`,
          1,
        ),
      );
    }
    if (path.basename(filePath) === "index.md") {
      validateIndexBody(raw, filePath, repoRoot, findings);
    } else {
      validateLogBody(raw, filePath, repoRoot, findings);
    }
    return raw;
  }

  let body = raw;
  if (hasLeadingFrontmatter(raw)) {
    const parsed = splitFrontmatter(raw, filePath, repoRoot, findings);
    if (parsed) {
      body = parsed.body;
      const keys = Object.keys(parsed.fields);
      if (keys.length !== 1 || keys[0] !== "okf_version" || parsed.fields.okf_version !== "0.1") {
        findings.push(
          finding(
            "core",
            "CORE_ROOT_INDEX",
            filePath,
            repoRoot,
            'root index frontmatter may contain only `okf_version: "0.1"`',
          ),
        );
      }
    }
  }
  validateIndexBody(body, filePath, repoRoot, findings);
  return body;
}

function validateStringField(
  fields: Record<string, unknown>,
  field: string,
  filePath: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): boolean {
  const value = fields[field];
  if (typeof value === "string" && value.trim() !== "") return true;
  findings.push(
    finding(
      "profile",
      "PROFILE_REQUIRED_FIELD",
      filePath,
      repoRoot,
      `profile requires a non-empty string \`${field}\` field`,
    ),
  );
  return false;
}

function validateSourcePaths(
  value: unknown,
  filePath: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): void {
  const sourcePaths = asStringList(value);
  if (!sourcePaths) {
    findings.push(
      finding(
        "profile",
        "PROFILE_SOURCE_PATHS",
        filePath,
        repoRoot,
        "profile requires `source_paths` to be a non-empty string list",
      ),
    );
    return;
  }

  for (const sourcePath of sourcePaths) {
    if (path.isAbsolute(sourcePath) || sourcePath.split("/").includes("..")) {
      findings.push(
        finding(
          "hygiene",
          "HYGIENE_SOURCE_PATH",
          filePath,
          repoRoot,
          `source path must stay repository-relative: \`${sourcePath}\``,
        ),
      );
      continue;
    }
    try {
      if (fs.globSync(sourcePath, { cwd: repoRoot }).length === 0) {
        findings.push(
          finding(
            "hygiene",
            "HYGIENE_SOURCE_PATH",
            filePath,
            repoRoot,
            `source path matches no repository entry: \`${sourcePath}\``,
          ),
        );
      }
    } catch (error) {
      findings.push(
        finding(
          "hygiene",
          "HYGIENE_SOURCE_PATH",
          filePath,
          repoRoot,
          `source path is not a valid glob: \`${sourcePath}\` (${(error as Error).message})`,
        ),
      );
    }
  }
}

function validateConceptProfile(
  bundleRoot: string,
  filePath: string,
  fields: Record<string, unknown>,
  profile: KnowledgeProfile,
  repoRoot: string,
  findings: KnowledgeFinding[],
): void {
  for (const field of profile.requiredFields) {
    if (field === "source_paths") {
      validateSourcePaths(fields.source_paths, filePath, repoRoot, findings);
    } else {
      validateStringField(fields, field, filePath, repoRoot, findings);
    }
  }

  if (typeof fields.type === "string" && !profile.allowedTypes.includes(fields.type)) {
    findings.push(
      finding(
        "profile",
        "PROFILE_TYPE",
        filePath,
        repoRoot,
        `type must be one of: ${profile.allowedTypes.join(", ")}`,
      ),
    );
  }
  if (typeof fields.status === "string" && !profile.allowedStatuses.includes(fields.status)) {
    findings.push(
      finding(
        "profile",
        "PROFILE_STATUS",
        filePath,
        repoRoot,
        `status must be one of: ${profile.allowedStatuses.join(", ")}`,
      ),
    );
  }

  const conceptPath = path.relative(bundleRoot, filePath).split(path.sep).join("/");
  if (
    profile.highConsequenceConcepts.has(conceptPath) &&
    (typeof fields.owner !== "string" || fields.owner.trim() === "")
  ) {
    findings.push(
      finding(
        "profile",
        "PROFILE_OWNER",
        filePath,
        repoRoot,
        "high-consequence concept requires a non-empty `owner` field",
      ),
    );
  }
}

function withoutCodeExamples(markdown: string): string {
  const output: string[] = [];
  let fence: "`" | "~" | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1]?.[0] as "`" | "~" | undefined;
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      output.push("");
      continue;
    }
    output.push(fence ? "" : line.replace(/`[^`]*`/g, ""));
  }
  return output.join("\n");
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of withoutCodeExamples(markdown).split("\n")) {
    const match = line.match(HEADING);
    if (!match) continue;
    const base = match[1]
      .replace(/\s+#+\s*$/, "")
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/ /g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function linkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim().replace(/^<|>$/g, "");
  return trimmed.split(/\s+["']/)[0];
}

function validateLinks(
  bundleRoot: string,
  filePath: string,
  markdown: string,
  repoRoot: string,
  findings: KnowledgeFinding[],
): void {
  for (const [lineIndex, line] of withoutCodeExamples(markdown).split("\n").entries()) {
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const target = linkTarget(match[1]);
      if (!target || target.startsWith("//") || EXTERNAL_SCHEME.test(target)) continue;

      const hashIndex = target.indexOf("#");
      const pathAndQuery = hashIndex < 0 ? target : target.slice(0, hashIndex);
      let fragment: string;
      let linkPath: string;
      try {
        fragment =
          hashIndex < 0 ? "" : decodeURIComponent(target.slice(hashIndex + 1)).toLowerCase();
        linkPath = decodeURIComponent(pathAndQuery.split("?")[0]);
      } catch {
        findings.push(
          finding(
            "hygiene",
            "HYGIENE_LINK",
            filePath,
            repoRoot,
            `local link has malformed percent-encoding: \`${target}\``,
            lineIndex + 1,
          ),
        );
        continue;
      }
      const targetPath = linkPath
        ? path.resolve(
            linkPath.startsWith("/") ? bundleRoot : path.dirname(filePath),
            linkPath.replace(/^\//, ""),
          )
        : filePath;
      const relative = path.relative(repoRoot, targetPath);

      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(targetPath)) {
        findings.push(
          finding(
            "hygiene",
            "HYGIENE_LINK",
            filePath,
            repoRoot,
            `broken local link: \`${target}\``,
            lineIndex + 1,
          ),
        );
        continue;
      }

      if (fragment && fs.statSync(targetPath).isFile() && path.extname(targetPath) === ".md") {
        const anchors = headingSlugs(fs.readFileSync(targetPath, "utf8"));
        if (!anchors.has(fragment)) {
          findings.push(
            finding(
              "hygiene",
              "HYGIENE_ANCHOR",
              filePath,
              repoRoot,
              `missing Markdown anchor \`${fragment}\` in \`${relativeToRepo(repoRoot, targetPath)}\``,
              lineIndex + 1,
            ),
          );
        }
      }
    }
  }
}

function markdownFiles(root: string): string[] {
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

function validateProfileMembership(
  profile: KnowledgeProfile,
  profilePath: string,
  bundleRoot: string,
  conceptFiles: string[],
  repoRoot: string,
  findings: KnowledgeFinding[],
): void {
  const conceptsByPath = new Map(
    conceptFiles.map((filePath) => [
      path.relative(bundleRoot, filePath).split(path.sep).join("/"),
      filePath,
    ]),
  );

  for (const conceptPath of profile.conceptPaths) {
    if (
      conceptPath.startsWith("../") ||
      path.posix.isAbsolute(conceptPath) ||
      !conceptsByPath.has(conceptPath)
    ) {
      findings.push(
        finding(
          "profile",
          "PROFILE_CONCEPT_MEMBERSHIP",
          profilePath,
          repoRoot,
          `profile concept does not resolve to an existing non-reserved concept: \`${conceptPath}\``,
        ),
      );
    }
  }

  for (const [conceptPath, filePath] of conceptsByPath) {
    if (!profile.conceptPaths.has(conceptPath)) {
      findings.push(
        finding(
          "profile",
          "PROFILE_CONCEPT_MEMBERSHIP",
          filePath,
          repoRoot,
          `concept is missing from profile concepts: \`${conceptPath}\``,
        ),
      );
    }
  }
}

export function validateKnowledge(options: KnowledgeValidationOptions): KnowledgeValidationReport {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const bundleRoot = path.resolve(repoRoot, options.bundleRoot);
  const profilePath = path.resolve(repoRoot, options.profilePath);
  const findings: KnowledgeFinding[] = [];

  if (!fs.existsSync(bundleRoot) || !fs.statSync(bundleRoot).isDirectory()) {
    findings.push(
      finding("core", "CORE_BUNDLE", bundleRoot, repoRoot, "knowledge bundle is not a directory"),
    );
    return {
      bundleRoot,
      profilePath,
      filesScanned: 0,
      findings,
      valid: false,
    };
  }

  const files = markdownFiles(bundleRoot);
  const conceptFiles = files.filter(
    (filePath) => !["index.md", "log.md"].includes(path.basename(filePath)),
  );
  const profile = loadProfile(profilePath, bundleRoot, repoRoot, findings);
  if (profile) {
    validateProfileMembership(profile, profilePath, bundleRoot, conceptFiles, repoRoot, findings);
  }
  const titles = new Map<string, string>();

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, "utf8");
    if (filePath.endsWith(`${path.sep}index.md`) || filePath.endsWith(`${path.sep}log.md`)) {
      const body = validateReservedFile(bundleRoot, filePath, raw, repoRoot, findings);
      validateLinks(bundleRoot, filePath, body, repoRoot, findings);
      continue;
    }

    const frontmatter = splitFrontmatter(raw, filePath, repoRoot, findings);
    if (!frontmatter) {
      validateLinks(bundleRoot, filePath, raw, repoRoot, findings);
      continue;
    }
    if (typeof frontmatter.fields.type !== "string" || frontmatter.fields.type.trim() === "") {
      findings.push(
        finding(
          "core",
          "CORE_TYPE",
          filePath,
          repoRoot,
          "concept requires a non-empty string `type` field",
        ),
      );
    }

    if (profile) {
      validateConceptProfile(bundleRoot, filePath, frontmatter.fields, profile, repoRoot, findings);
    }
    validateLinks(bundleRoot, filePath, frontmatter.body, repoRoot, findings);

    if (typeof frontmatter.fields.title === "string" && frontmatter.fields.title.trim()) {
      const normalizedTitle = frontmatter.fields.title.trim().toLocaleLowerCase("en");
      const previous = titles.get(normalizedTitle);
      if (previous) {
        findings.push(
          finding(
            "hygiene",
            "HYGIENE_DUPLICATE_TITLE",
            filePath,
            repoRoot,
            `duplicates title from \`${relativeToRepo(repoRoot, previous)}\``,
          ),
        );
      } else {
        titles.set(normalizedTitle, filePath);
      }
    }
  }

  return {
    bundleRoot,
    profilePath,
    filesScanned: files.length,
    findings,
    valid: findings.length === 0,
  };
}
