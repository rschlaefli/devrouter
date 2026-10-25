import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPreviewManifest, parsePreviewManifest } from "../manifest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function validSource(): string {
  return `
version: 1
aliases:
  web:
    profiles: [web]
  data:
    resources: [db]
bindings:
  apps:
    web: [web]
  dependencies:
    db: [db]
  services:
    cache: [cache]
  processes:
    cleanup: []
resources:
  web:
    kind: service
    dependsOn: [db, cache]
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
    ports:
      - name: http
        port: 3000
        public: true
    command: ["node", "server.js"]
  worker:
    kind: job
    image: ghcr.io/example/worker:1.2.3
    command: ["node", "worker.js"]
  db:
    kind: postgres
    dependsOn: [assets]
  cache:
    kind: redis
  assets:
    kind: volume
selection:
  rules:
    - paths: ["apps/**"]
      aliases: [web]
  ignorePaths: ["docs/**"]
  controlPaths: ["config/preview/**"]
  fallback: data
  dominating: web
  allowedUnions:
    - [web, data]
`;
}

describe("preview manifest", () => {
  it("parses the closed v1 resource and selection schema", () => {
    const manifest = parsePreviewManifest(validSource());

    expect(manifest.resources.web).toEqual({
      kind: "service",
      dependsOn: ["db", "cache"],
      build: { context: ".", dockerfile: "Dockerfile", target: "runtime" },
      ports: [{ name: "http", port: 3000, public: true }],
      command: ["node", "server.js"],
    });
    expect(manifest.bindings.processes.cleanup).toEqual([]);
    expect(manifest.selection.allowedUnions).toEqual([["web", "data"]]);
  });

  it("rejects unknown fields, invalid resource shapes and unsafe paths", () => {
    expect(() =>
      parsePreviewManifest(validSource().replace("version: 1", "version: 1\nprovider: {}")),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(
        validSource().replace("kind: service", "kind: service\n    image: nginx"),
      ),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(validSource().replace("kind: volume", "kind: volume\n    ports: []")),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(validSource().replace("context: .", "context: ../outside")),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(
        validSource().replace(
          "ghcr.io/example/worker:1.2.3",
          "https://user:secret@registry.example/worker",
        ),
      ),
    ).toThrow();
  });

  it("accepts existing local names while keeping preview-owned identifiers strict", () => {
    const manifest = parsePreviewManifest(
      validSource()
        .replace("profiles: [web]", "profiles: [Web_Profile]")
        .replace("    cache: [cache]", "    my_db: [cache]")
        .replace("    cleanup: []", "    worker.queue: []"),
    );
    expect(manifest.aliases.web).toEqual({ profiles: ["Web_Profile"] });
    expect(manifest.bindings.services.my_db).toEqual(["cache"]);
    expect(manifest.bindings.processes["worker.queue"]).toEqual([]);
    expect(() =>
      parsePreviewManifest(validSource().replace("  worker:\n", "  Bad_Id:\n")),
    ).toThrow();
  });

  it.each([
    "config/*.{yml,yaml}",
    "config/[ab].yml",
    "!private/**",
    "config/+(name).yml",
  ])("rejects unsupported control glob operators: %s", (pattern) => {
    expect(() =>
      parsePreviewManifest(validSource().replace("config/preview/**", pattern)),
    ).toThrow();
  });

  it("rejects dangling references and cycles across the full graph", () => {
    expect(() =>
      parsePreviewManifest(validSource().replace("dependsOn: [assets]", "dependsOn: [missing]")),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(validSource().replace("dependsOn: [assets]", "dependsOn: [web]")),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(validSource().replace("db: [db]", "db: [missing]")),
    ).toThrow();
  });

  it("rejects YAML aliases, merge keys and duplicate keys", () => {
    expect(() =>
      parsePreviewManifest(
        validSource().replace(
          "web:\n    profiles: [web]",
          "web: &profile\n    profiles: [web]\n  copy: *profile",
        ),
      ),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(
        validSource().replace("kind: postgres", "<<: &base {kind: postgres}\n    kind: postgres"),
      ),
    ).toThrow();
    expect(() =>
      parsePreviewManifest(validSource().replace("version: 1", "version: 1\nversion: 1")),
    ).toThrow();
  });

  it("loads a bounded regular manifest and binds it to its digest", () => {
    const repoPath = temporaryDirectory("devrouter-preview-manifest-");
    fs.writeFileSync(path.join(repoPath, ".devrouter.preview.yml"), validSource(), "utf-8");

    const loaded = loadPreviewManifest(repoPath);

    expect(loaded.manifest.version).toBe(1);
    expect(loaded.digest).toBe(createHash("sha256").update(validSource(), "utf-8").digest("hex"));
  });

  it("rejects symlinked and oversized manifest files", () => {
    const repoPath = temporaryDirectory("devrouter-preview-manifest-link-");
    const outsidePath = temporaryDirectory("devrouter-preview-manifest-outside-");
    const outsideManifest = path.join(outsidePath, ".devrouter.preview.yml");
    fs.writeFileSync(outsideManifest, validSource(), "utf-8");
    fs.symlinkSync(outsideManifest, path.join(repoPath, ".devrouter.preview.yml"));

    expect(() => loadPreviewManifest(repoPath)).toThrow();

    fs.unlinkSync(path.join(repoPath, ".devrouter.preview.yml"));
    fs.writeFileSync(
      path.join(repoPath, ".devrouter.preview.yml"),
      `#${"x".repeat(1024 * 1024)}`,
      "utf-8",
    );
    expect(() => loadPreviewManifest(repoPath)).toThrow();
  });
});
