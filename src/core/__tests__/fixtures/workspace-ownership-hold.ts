import { withWorkspaceOwnershipTransaction } from "../../workspace-ownership";

const repoPath = process.argv[2];
const holdMs = Number(process.argv[3]);
if (!repoPath || !Number.isFinite(holdMs)) {
  throw new Error("usage: workspace-ownership-hold <repo> <milliseconds>");
}

withWorkspaceOwnershipTransaction(repoPath, () => {
  process.stdout.write("ready\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
});
