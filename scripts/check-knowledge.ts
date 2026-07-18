import {
  type KnowledgeFindingCategory,
  validateKnowledge,
} from "../src/tooling/knowledge-validator";

const repoRoot = process.cwd();
const bundleRoot = process.argv[2] ?? "docs/knowledge";
const profilePath = process.argv[3] ?? "docs/knowledge/profile.yaml";
const report = validateKnowledge({ bundleRoot, profilePath, repoRoot });
const categories: KnowledgeFindingCategory[] = ["core", "profile", "hygiene"];

if (report.valid) {
  console.log(`PASS: knowledge validation (${report.filesScanned} Markdown files).`);
} else {
  console.error(`FAIL: knowledge validation found ${report.findings.length} issue(s).`);
  for (const category of categories) {
    const categoryFindings = report.findings.filter((item) => item.category === category);
    if (categoryFindings.length === 0) continue;
    console.log(`\n${category.toUpperCase()} (${categoryFindings.length})`);
    for (const item of categoryFindings) {
      const location = item.line ? `${item.path}:${item.line}` : item.path;
      console.log(`- ${item.code} ${location}: ${item.message}`);
    }
  }
  process.exitCode = 1;
}
