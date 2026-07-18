import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./file-lock";
import { DEVROUTER_HOME } from "./router";

const DEVPOD_MUTATION_LOCK_FILE = path.join(DEVROUTER_HOME, "devpod-mutation.lock");
const DEVPOD_MUTATION_WAIT_MS = 60_000;

export function withDevpodMutationLockSync<T>(
  activity: string,
  target: string,
  operation: () => T,
): T {
  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  return withFileLockSync(
    DEVPOD_MUTATION_LOCK_FILE,
    { activity, target: `'${target}'`, waitMs: DEVPOD_MUTATION_WAIT_MS },
    operation,
  );
}
