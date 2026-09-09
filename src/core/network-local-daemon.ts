import fs from "node:fs";
import path from "node:path";

/** A local socket alone may be forwarded to another host or network namespace. */
export function hasLocalDockerNetworkNamespace(endpoint: string, procRoot = "/proc"): boolean {
  const deadline = Date.now() + 2000;
  try {
    if (!endpoint.startsWith("unix:///")) return false;
    const socket = endpoint.slice("unix://".length);
    const table = fs.readFileSync(path.join(procRoot, "net/unix"), "utf8");
    if (Buffer.byteLength(table) > 1024 * 1024) return false;
    const rows = table
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((row) => row[7] === socket && row[3] === "00010000");
    if (rows.length !== 1 || !/^\d+$/.test(rows[0][6])) return false;
    const inode = `socket:[${rows[0][6]}]`;
    const ownNamespace = fs.readlinkSync(path.join(procRoot, "self/ns/net"));
    const pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
    if (pids.length > 4096) return false;
    for (const pid of pids) {
      if (Date.now() > deadline) return false;
      try {
        const root = path.join(procRoot, pid);
        if (path.basename(fs.readlinkSync(path.join(root, "exe"))) !== "dockerd") continue;
        if (fs.readlinkSync(path.join(root, "ns/net")) !== ownNamespace) continue;
        const descriptors = fs.readdirSync(path.join(root, "fd"));
        if (descriptors.length > 4096) continue;
        if (
          descriptors.some((fd) => {
            if (Date.now() > deadline) return false;
            try {
              return fs.readlinkSync(path.join(root, "fd", fd)) === inode;
            } catch {
              return false;
            }
          })
        )
          return true;
      } catch {
        /* Inaccessible processes cannot establish local daemon proof. */
      }
    }
  } catch {
    return false;
  }
  return false;
}
