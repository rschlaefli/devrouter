import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasLocalDockerNetworkNamespace } from "../network-local-daemon";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function fixture(namespace = "net:[1]") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "network-namespace-"));
  roots.push(root);
  for (const dir of ["net", "self/ns", "12/ns", "12/fd"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(
    path.join(root, "net/unix"),
    "0000: 00000002 00000000 00010000 0001 01 456 /synthetic.sock\n",
  );
  fs.symlinkSync("net:[1]", path.join(root, "self/ns/net"));
  fs.symlinkSync(namespace, path.join(root, "12/ns/net"));
  fs.symlinkSync("/usr/bin/dockerd", path.join(root, "12/exe"));
  fs.symlinkSync("socket:[456]", path.join(root, "12/fd/7"));
  return root;
}
describe("Docker host route correspondence", () => {
  it("requires the listening dockerd socket in the caller network namespace", () => {
    expect(hasLocalDockerNetworkNamespace("unix:///synthetic.sock", fixture())).toBe(true);
    expect(hasLocalDockerNetworkNamespace("unix:///synthetic.sock", fixture("net:[2]"))).toBe(
      false,
    );
    expect(hasLocalDockerNetworkNamespace("unix:///different.sock", fixture())).toBe(false);
  });
});
