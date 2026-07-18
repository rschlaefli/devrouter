import fs from "node:fs";
import path from "node:path";
import {
  asStringList,
  type KnowledgeValidationContext,
  relativeToRepo,
  reportFinding,
} from "./knowledge-validator-context";
import type { KnowledgeDocument } from "./knowledge-validator-core";

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const INLINE_CODE = /\x60[^\x60]*\x60/g;

export function validateSourcePaths(
  context: KnowledgeValidationContext,
  document: KnowledgeDocument,
  value: unknown,
): void {
  const sourcePaths = asStringList(value);
  if (!sourcePaths) {
    reportFinding(
      context,
      "profile",
      "PROFILE_SOURCE_PATHS",
      document.filePath,
      "profile requires source_paths to be a non-empty string list",
    );
    return;
  }

  for (const sourcePath of sourcePaths) {
    if (path.isAbsolute(sourcePath) || sourcePath.split("/").includes("..")) {
      reportFinding(
        context,
        "hygiene",
        "HYGIENE_SOURCE_PATH",
        document.filePath,
        `source path must stay repository-relative: ${sourcePath}`,
      );
      continue;
    }
    try {
      if (fs.globSync(sourcePath, { cwd: context.repoRoot }).length === 0) {
        reportFinding(
          context,
          "hygiene",
          "HYGIENE_SOURCE_PATH",
          document.filePath,
          `source path matches no repository entry: ${sourcePath}`,
        );
      }
    } catch (error) {
      reportFinding(
        context,
        "hygiene",
        "HYGIENE_SOURCE_PATH",
        document.filePath,
        `source path is not a valid glob: ${sourcePath} (${(error as Error).message})`,
      );
    }
  }
}

function withoutCodeExamples(markdown: string): string {
  const output: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.trimStart().match(/^([~\x60]{3,})/)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      output.push("");
      continue;
    }
    output.push(fence ? "" : line.replace(INLINE_CODE, ""));
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

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function reportBrokenLink(
  context: KnowledgeValidationContext,
  document: KnowledgeDocument,
  target: string,
  line: number,
  reason = "broken local link",
): void {
  reportFinding(
    context,
    "hygiene",
    "HYGIENE_LINK",
    document.filePath,
    `${reason}: ${target}`,
    line,
  );
}

function validateLinks(context: KnowledgeValidationContext, document: KnowledgeDocument): void {
  const realRepoRoot = fs.realpathSync(context.repoRoot);
  for (const [lineIndex, line] of withoutCodeExamples(document.body).split("\n").entries()) {
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
        reportBrokenLink(
          context,
          document,
          target,
          lineIndex + 1,
          "local link has malformed percent-encoding",
        );
        continue;
      }

      const targetPath = linkPath
        ? path.resolve(
            linkPath.startsWith("/") ? context.bundleRoot : path.dirname(document.filePath),
            linkPath.replace(/^\//, ""),
          )
        : document.filePath;
      if (!isContained(context.repoRoot, targetPath) || !fs.existsSync(targetPath)) {
        reportBrokenLink(context, document, target, lineIndex + 1);
        continue;
      }

      const realTargetPath = fs.realpathSync(targetPath);
      if (!isContained(realRepoRoot, realTargetPath)) {
        reportBrokenLink(
          context,
          document,
          target,
          lineIndex + 1,
          "local link escapes the repository through a symlink",
        );
        continue;
      }

      if (
        fragment &&
        fs.statSync(realTargetPath).isFile() &&
        path.extname(realTargetPath) === ".md"
      ) {
        const anchors = headingSlugs(fs.readFileSync(realTargetPath, "utf8"));
        if (!anchors.has(fragment)) {
          reportFinding(
            context,
            "hygiene",
            "HYGIENE_ANCHOR",
            document.filePath,
            `missing Markdown anchor ${fragment} in ${relativeToRepo(context, targetPath)}`,
            lineIndex + 1,
          );
        }
      }
    }
  }
}

export function validateKnowledgeHygiene(
  context: KnowledgeValidationContext,
  documents: KnowledgeDocument[],
): void {
  const titles = new Map<string, string>();
  for (const document of documents) {
    validateLinks(context, document);
    if (document.kind !== "concept") continue;
    const title = document.fields?.title;
    if (typeof title !== "string" || !title.trim()) continue;

    const normalizedTitle = title.trim().toLocaleLowerCase("en");
    const previous = titles.get(normalizedTitle);
    if (previous) {
      reportFinding(
        context,
        "hygiene",
        "HYGIENE_DUPLICATE_TITLE",
        document.filePath,
        `duplicates title from ${relativeToRepo(context, previous)}`,
      );
    } else {
      titles.set(normalizedTitle, document.filePath);
    }
  }
}
