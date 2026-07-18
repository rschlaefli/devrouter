import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateKnowledge } from "../knowledge-validator";

let repoRoot: string;

const VALID_PROFILE = `
version: 1
bundle: docs/knowledge
required_fields:
  - type
  - title
  - description
  - status
  - source_paths
allowed_types:
  - Repository Guide
  - Workflow
allowed_statuses:
  - draft
  - active
  - deprecated
  - superseded
concepts:
  repository-guide.md:
    high_consequence: false
`;

function write(relativePath: string, contents: string): void {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents.trimStart(), "utf8");
}

function validConcept(overrides = "", body = "# Repository guide"): string {
  return `
---
type: Repository Guide
title: Repository guide
description: Explains how to find authoritative repository knowledge.
status: active
source_paths:
  - src/**
${overrides}---

${body}
`;
}

function addProfileConcept(conceptPath: string, highConsequence = false): void {
  write(
    "docs/knowledge/profile.yaml",
    `${fs.readFileSync(path.join(repoRoot, "docs/knowledge/profile.yaml"), "utf8")}  ${conceptPath}:
    high_consequence: ${highConsequence}
`,
  );
}

function validate() {
  return validateKnowledge({
    repoRoot,
    bundleRoot: "docs/knowledge",
    profilePath: "docs/knowledge/profile.yaml",
  });
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-knowledge-"));
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  write("src/example.ts", "export {};\n");
  write(
    "docs/knowledge/index.md",
    `---
okf_version: "0.1"
---

# Repository knowledge

- [Repository guide](repository-guide.md)
`,
  );
  write("docs/knowledge/profile.yaml", VALID_PROFILE);
  write("docs/knowledge/repository-guide.md", validConcept("producer_extension: retained\n"));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("validateKnowledge", () => {
  it("accepts a valid bundle and tolerates unknown producer and profile fields", () => {
    write("docs/knowledge/profile.yaml", `${VALID_PROFILE}\nproducer_extension: retained\n`);

    expect(validate()).toMatchObject({ valid: true, findings: [] });
  });

  it("validates profile version and bundle identity without policy fallbacks", () => {
    write(
      "docs/knowledge/profile.yaml",
      VALID_PROFILE.replace("version: 1", "version: 2").replace(
        "bundle: docs/knowledge",
        "bundle: other/knowledge",
      ),
    );

    const schemaFindings = validate().findings.filter((item) => item.code === "PROFILE_SCHEMA");
    expect(schemaFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "version must be 1" }),
        expect.objectContaining({ message: "bundle must be `docs/knowledge`" }),
      ]),
    );
  });

  it("requires the repository profile's fixed metadata fields", () => {
    write(
      "docs/knowledge/profile.yaml",
      VALID_PROFILE.replace(
        `required_fields:
  - type
  - title
  - description
  - status
  - source_paths`,
        `required_fields:
  - type`,
      ),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "profile",
          code: "PROFILE_SCHEMA",
          message: "required_fields must include: title, description, status, source_paths",
        }),
      ]),
    );
  });

  it("reports missing or non-string concept types as core findings", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept().replace("type: Repository Guide", "type: []"),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "core", code: "CORE_TYPE" })]),
    );
  });

  it("allows only okf_version 0.1 in root index frontmatter", () => {
    write(
      "docs/knowledge/index.md",
      `---
okf_version: "0.2"
title: Not allowed
---
# Repository knowledge
`,
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "core", code: "CORE_ROOT_INDEX" }),
      ]),
    );
  });

  it("rejects frontmatter in nested indexes and logs", () => {
    write(
      "docs/knowledge/nested/index.md",
      `---
type: Repository Guide
---
# Nested
`,
    );
    write(
      "docs/knowledge/log.md",
      `---
type: Repository Guide
---
# Log
`,
    );

    const reservedFindings = validate().findings.filter(
      (item) => item.code === "CORE_RESERVED_FRONTMATTER",
    );
    expect(reservedFindings).toHaveLength(2);
  });

  it("requires nonempty indexes with a heading and Markdown list link", () => {
    write(
      "docs/knowledge/index.md",
      `---
okf_version: "0.1"
---
`,
    );
    write("docs/knowledge/nested/index.md", "Plain text only\n");

    const findings = validate().findings.filter((item) => item.code === "CORE_INDEX_STRUCTURE");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "index must not be empty" }),
        expect.objectContaining({ message: "index must contain a level-1 heading" }),
        expect.objectContaining({
          message: "index must contain at least one Markdown list link",
        }),
      ]),
    );
  });

  it("requires logs to use valid newest-first ISO date groups", () => {
    write(
      "docs/knowledge/log.md",
      `# Updates

## 2026-07-17
- Older

## not-a-date
- Invalid

## 2026-07-18
- Newer
`,
    );

    const findings = validate().findings.filter((item) => item.code === "CORE_LOG_STRUCTURE");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "level-2 log headings must use a valid `## YYYY-MM-DD` date",
        }),
        expect.objectContaining({ message: "log date groups must be newest first" }),
      ]),
    );
  });

  it("requires all profile fields", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept().replace(
        "description: Explains how to find authoritative repository knowledge.\n",
        "",
      ),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "profile",
          code: "PROFILE_REQUIRED_FIELD",
          message: expect.stringContaining("description"),
        }),
      ]),
    );
  });

  it("enforces profile type and status vocabularies", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept()
        .replace("type: Repository Guide", "type: Mystery")
        .replace("status: active", "status: unknown"),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "profile", code: "PROFILE_TYPE" }),
        expect.objectContaining({ category: "profile", code: "PROFILE_STATUS" }),
      ]),
    );
  });

  it("requires an owner for profile-marked high-consequence concepts", () => {
    addProfileConcept("lifecycle.md", true);
    write("docs/knowledge/lifecycle.md", validConcept("", "# Lifecycle"));

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "profile", code: "PROFILE_OWNER" }),
      ]),
    );
  });

  it("reports broken local Markdown paths but ignores links in code examples", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept(
        "",
        `# Repository guide

[Missing](missing.md)

[External](https://example.invalid/missing.md)

\`[Inline example](also-missing.md)\`

\`\`\`markdown
[Fenced example](still-missing.md)
\`\`\`
`,
      ),
    );

    const linkFindings = validate().findings.filter((item) => item.code === "HYGIENE_LINK");
    expect(linkFindings).toHaveLength(1);
    expect(linkFindings[0].message).toContain("missing.md");
  });

  it("reports malformed percent-encoding in local links", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept("", "# Repository guide\n\n[Malformed](bad%zz.md)"),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "hygiene",
          code: "HYGIENE_LINK",
          message: expect.stringContaining("malformed percent-encoding"),
        }),
      ]),
    );
  });

  it("reports missing local Markdown anchors", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept("", "# Repository guide\n\n[Wrong anchor](target.md#missing)"),
    );
    write(
      "docs/knowledge/target.md",
      validConcept("", "# Present").replace("title: Repository guide", "title: Target"),
    );
    addProfileConcept("target.md");

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "hygiene", code: "HYGIENE_ANCHOR" }),
      ]),
    );
  });

  it("reports duplicate concept titles", () => {
    write("docs/knowledge/duplicate.md", validConcept("", "# Duplicate"));
    addProfileConcept("duplicate.md");

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "hygiene", code: "HYGIENE_DUPLICATE_TITLE" }),
      ]),
    );
  });

  it("reports source paths that do not exist", () => {
    write(
      "docs/knowledge/repository-guide.md",
      validConcept().replace("  - src/**", "  - absent/path/*.ts"),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "hygiene", code: "HYGIENE_SOURCE_PATH" }),
      ]),
    );
  });

  it("reports source globs with an existing prefix but no actual match", () => {
    fs.mkdirSync(path.join(repoRoot, "src/core"), { recursive: true });
    write(
      "docs/knowledge/repository-guide.md",
      validConcept().replace("  - src/**", "  - src/core/missing*.ts"),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "hygiene",
          code: "HYGIENE_SOURCE_PATH",
          message: expect.stringContaining("matches no repository entry"),
        }),
      ]),
    );
  });

  it("reports profile concept typos and concepts omitted from the profile", () => {
    write(
      "docs/knowledge/profile.yaml",
      VALID_PROFILE.replace("repository-guide.md", "repository-typo.md"),
    );

    const findings = validate().findings.filter(
      (item) => item.code === "PROFILE_CONCEPT_MEMBERSHIP",
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("does not resolve to an existing non-reserved concept"),
        }),
        expect.objectContaining({ message: expect.stringContaining("missing from profile") }),
      ]),
    );
  });

  it("reports an added concept omitted from profile concepts", () => {
    write(
      "docs/knowledge/omitted.md",
      validConcept("", "# Omitted").replace("title: Repository guide", "title: Omitted"),
    );

    expect(validate().findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "profile",
          code: "PROFILE_CONCEPT_MEMBERSHIP",
          path: "docs/knowledge/omitted.md",
        }),
      ]),
    );
  });
});
