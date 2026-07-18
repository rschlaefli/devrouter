import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../../file-lock";
import { DEVROUTER_HOME } from "../../router";

const activity = process.argv[2] ?? "DevPod mutation test";
const waitForRelease = process.argv[3] === "wait";

process.stdout.write("attempting\n");
fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
withFileLockSync(
  path.join(DEVROUTER_HOME, "devpod-mutation.lock"),
  { activity, target: `'${process.cwd()}'`, waitMs: 60_000 },
  () => {
    process.stdout.write("entered\n");
    if (waitForRelease) fs.readFileSync(0, "utf-8");
  },
);
