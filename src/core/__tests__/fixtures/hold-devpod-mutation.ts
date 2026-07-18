import fs from "node:fs";
import { withDevpodMutationLockSync } from "../../devpod-mutation";

const activity = process.argv[2] ?? "DevPod mutation test";
const waitForRelease = process.argv[3] === "wait";

process.stdout.write("attempting\n");
withDevpodMutationLockSync(activity, process.cwd(), () => {
  process.stdout.write("entered\n");
  if (waitForRelease) fs.readFileSync(0, "utf-8");
});
