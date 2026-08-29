import fs from "node:fs";
import { workspaceUp } from "../../workspace-lifecycle";

const repoPath = process.argv[2];
const branch = process.argv[3];
if (!repoPath || !branch) throw new Error("usage: workspace-up-create-only <repo> <branch>");

async function main(): Promise<void> {
  process.stdout.write("ready\n");
  fs.readFileSync(0, "utf-8");
  await workspaceUp(branch, { repoPath, noDevpod: true });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
