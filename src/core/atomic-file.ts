import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fsyncDirectory(directory: string): void {
  const handle = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

export function writeFileAtomically(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryHandle: number | undefined;
  try {
    temporaryHandle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(temporaryHandle, contents, "utf-8");
    fs.fsyncSync(temporaryHandle);
    fs.closeSync(temporaryHandle);
    temporaryHandle = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (temporaryHandle !== undefined) fs.closeSync(temporaryHandle);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}
