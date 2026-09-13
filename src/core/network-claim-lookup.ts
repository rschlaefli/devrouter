import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  NETWORK_CLAIMS_MAX_FILE_BYTES,
  NETWORK_CLAIMS_ROOT,
  type NetworkClaim,
  readNetworkClaim,
} from "./network-claims";

export function networkOwnerKey(repoPath: string): string {
  if (!path.isAbsolute(repoPath) || path.resolve(repoPath) !== repoPath)
    throw new Error("Invalid network owner path.");
  return createHash("sha256").update(repoPath).digest("hex");
}

/** Find retained claims even when the current policy or Docker daemon changes. */
export function findOwnedNetworkClaim(
  repoPath: string,
  root = NETWORK_CLAIMS_ROOT,
): NetworkClaim | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Network claims cannot be inspected; repair is required.");
  }
  const files = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  if (files.length > 128) throw new Error("Network daemon inventory exceeds its bound.");
  let found: NetworkClaim | undefined;
  for (const file of files) {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > NETWORK_CLAIMS_MAX_FILE_BYTES)
      throw new Error("Invalid retained network claim file.");
    let value: { daemonId?: unknown };
    const descriptor = fs.openSync(
      full,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error();
      const bytes = Buffer.alloc(NETWORK_CLAIMS_MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(descriptor, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > NETWORK_CLAIMS_MAX_FILE_BYTES) throw new Error();
      value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    } catch {
      throw new Error("Retained network claim could not be read safely.");
    } finally {
      fs.closeSync(descriptor);
    }
    if (
      typeof value.daemonId !== "string" ||
      `${createHash("sha256").update(value.daemonId).digest("hex")}.json` !== file
    )
      throw new Error("Retained network daemon identity is invalid.");
    const claim = readNetworkClaim({
      daemonId: value.daemonId,
      root,
      ownerKey: networkOwnerKey(repoPath),
    });
    if (claim) {
      if (found) throw new Error("Workspace has conflicting network claims; repair is required.");
      found = claim;
    }
  }
  return found;
}
